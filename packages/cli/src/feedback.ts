// The feedback offer. When OpenQodex fails, a scanner breaks, or the developer
// runs `openqodex report`, it prints the exact GitHub issue it would create
// and two choices: 1 create the issue, 2 ignore. Nothing is ever sent without
// choice 1. The issue body never holds code, file names, paths, repo names,
// config or secrets: only the command's flags, a scrubbed error line, the
// scanner statuses and the platform.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { STATE_DIR, findRepoRoot, readRepoFile, repoStat, writeRepoFile } from "@openqodex/core";
import type { ScanResult, ScannerRunSummary } from "@openqodex/core";
import { homeGuard } from "./agents/guarded-fs.js";
import { openqodexHomeDir } from "./launcher.js";

const execFileAsync = promisify(execFile);

export const ISSUE_REPO = "openqodex/openqodex";
export const SEND_LAST = "openqodex report --send-last";
const LAST_REPORT = "last-report.json";
const DIAGNOSTIC_MAX = 300;
const INTERNAL_MAX = 120;

export type Problem = {
  // A short stable word for the failure class, so issues group.
  code: "internal-error" | "scanner-failed" | "developer-report";
  component: string;
  diagnostic: string;
};

export type Issue = { title: string; body: string };

// What this run learned, kept for the one offer at its end.
const run: {
  pending: Problem | null;
  scanners: ScannerRunSummary[] | null;
  repoRoot: string | null;
  outsideRepo: boolean;
} = { pending: null, scanners: null, repoRoot: null, outsideRepo: false };

// `--report-dir`: the run keeps nothing under .openqodex/ in the checkout,
// so a problem report shown in it is saved in the OpenQodex home instead.
export function keepRunStateOutOfRepo(): void {
  run.outsideRepo = true;
}

// A custom scanner's name comes from the repo's config, so the issue never
// shows it.
function scannerLabel(source: string): string {
  return source.startsWith("custom:") ? "custom scanner" : source;
}

const NOT_LISTED = "failed for a reason not listed";

// A scanner failure as a fixed class: the reason can hold the tool's stderr,
// so none of its text is kept beyond the class and an exit code. golangci
// runs once per Go module and joins the parts of its reason with "; ", after
// it turns any "; " in tool text into ", ", so each part gets its own class.
// Any other scanner's reason is one part: its "; " can be tool text.
export function failureClass(reason: string | null, source = ""): string {
  const r = reason ?? "";
  const parts = (source === "golangci" ? r.split("; ") : [r]).map(partClass);
  const listed = [...new Set(parts.filter((c) => c !== NOT_LISTED))];
  if (listed.length === 0) return NOT_LISTED;
  return parts.includes(NOT_LISTED) ? [...listed, "a reason not listed"].join(", ") : listed.join(", ");
}

// The fixed text the golangci adapter writes before any tool output, so it
// is matched first: a type-check message can quote anything.
const GOLANGCI_CLASSES: [RegExp, string][] = [
  // A changed Go package did not compile, so no linter read it.
  [/^[^:]*: could not type-check/, "could not type-check a changed package"],
  // The time for all Go modules ran out before this one started.
  [/^timed out before module/, "ran out of time before a Go module"],
  [/^skipped \d+ module\(s\) past the cap/, "skipped Go modules past the cap"],
  // Skips: reported only when another part of the run failed.
  [/^not run on .*\. No go\.mod is at or above/, "a changed Go file was outside any Go module"],
  [/^not run on .*\. Its dependencies are not in the Go module cache/, "Go dependencies were not downloaded"],
  // A part left out to keep the reason short.
  [/^and \d+ more$/, "more reasons left out"],
];

function partClass(r: string): string {
  const owned = GOLANGCI_CLASSES.find(([re]) => re.test(r));
  if (owned) return owned[1];
  const timeout = /timed out after (\d+)\s*s/.exec(r);
  if (timeout) return `timed out after ${timeout[1]} s`;
  const exit = /\bexit (\d+)\b/.exec(r);
  if (exit) return `exited with code ${exit[1]}`;
  const classes: [RegExp, string][] = [
    [/could not start/, "could not start"],
    [/more output than the limit/, "printed more output than the limit"],
    [/was killed/, "was killed"],
    [/wrote no report|no report/, "printed no report"],
    // golangci puts the Go module before its parse error: "backend: parse: ...".
    [/(^|: )parse:|read report|report too large/, "its report could not be read"],
    [/not a regular file/, "not a regular file"],
    [/outside the repo/, "a file was outside the repo"],
    [/larger than/, "a file was too large to read"],
  ];
  return classes.find(([re]) => re.test(r))?.[1] ?? NOT_LISTED;
}

// Called by the scan pipeline once the scanners have run. A scanner that
// ended `failed` queues the offer; every other status is not a problem.
export function noteScan(repoRoot: string, scan: ScanResult): void {
  run.repoRoot = repoRoot;
  run.scanners = scan.scanners;
  const failed = scan.scanners.filter((s) => s.status === "failed");
  if (failed.length === 0 || run.pending !== null) return;
  run.pending = {
    code: "scanner-failed",
    component: [...new Set(failed.map((s) => `scanner:${scannerLabel(s.scanner)}`))].join(", "),
    diagnostic: failed.map((s) => `${scannerLabel(s.scanner)}: ${failureClass(s.reason, s.scanner)}`).join("; "),
  };
}

// The CLI's own failure replaces a queued scanner failure: one offer per run.
// Kept: the error's class and its first line, scrubbed when the issue is made.
export function noteInternalError(command: string, args: string[], error: unknown): void {
  const component = command === "review" && args.includes("--finalize") ? "finalize" : "cli";
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  run.pending = { code: "internal-error", component, diagnostic: `${name}: ${firstLine(message)}` };
}

export function takePending(): Problem | null {
  const p = run.pending;
  run.pending = null;
  return p;
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The names that identify this user or this repo, longest first.
function privateNames(): string[] {
  const names = new Set<string>();
  for (const key of ["USER", "USERNAME", "LOGNAME"]) {
    const value = process.env[key];
    if (value) names.add(value);
  }
  try {
    names.add(userInfo().username);
  } catch {
    // no user entry for this uid
  }
  names.add(basename(homedir()));
  if (run.repoRoot !== null) names.add(basename(run.repoRoot));
  return [...names].filter((n) => n !== "").sort((a, b) => b.length - a.length);
}

export type Private = "a path" | "a file name" | "a key or token" | "an email address";

const KEY_PREFIXES = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "sk_live_", "sk_test_", "AKIA", "xox", "npm_", "glpat-", "AIza"];
const TOKEN = /[^\s'"`()[\]{}<>,;]+/g;

// What one word-like token is, or null when it is ordinary text.
function classify(core: string): Private | null {
  if (/^[^@]+@[^@]+\.[A-Za-z]{2,}$/.test(core)) return "an email address";
  if (KEY_PREFIXES.some((p) => core.startsWith(p) && core.length > p.length + 3)) return "a key or token";
  if (/[\\/]/.test(core) || core.startsWith("~")) return "a path";
  if (/^[A-Za-z0-9_+=.-]{16,}$/.test(core) && /[A-Za-z]/.test(core) && /\d/.test(core)) return "a key or token";
  if (/^[^.]+.*\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,5}$/.test(core)) return "a file name";
  return null;
}

const PLACEHOLDER: Record<Private, string> = {
  "a path": "<path>",
  "a file name": "<file>",
  "a key or token": "<secret>",
  "an email address": "<email>",
};

// Removes from a line of text everything that could point at the developer:
// quoted paths whole, private keys, labelled secrets (token=..., key: ...),
// anything shaped like a path, file name, key or email, then the user, home
// and repo names. Returns what it found, so `report` can refuse instead.
export function redact(text: string): { text: string; found: Set<Private> } {
  const found = new Set<Private>();
  const hit = (kind: Private): string => {
    found.add(kind);
    return PLACEHOLDER[kind];
  };
  let out = text.replace(/\s+/g, " ").trim();
  out = out.replace(/-----BEGIN[\s\S]*$/, () => hit("a key or token"));
  out = out.replace(/(['"`])([^'"`]*)\1/g, (whole, _q: string, inner: string) =>
    /[\\/]/.test(inner) || inner.startsWith("~") ? hit("a path") : whole,
  );
  out = out.replace(/([A-Za-z_][\w.-]*\s*[:=]\s*)([A-Za-z0-9_-]{20,})/g, (_w, label: string) => `${label}${hit("a key or token")}`);
  out = out.replace(TOKEN, (token) => {
    const trail = /[:.!?]+$/.exec(token)?.[0] ?? "";
    const core = token.slice(0, token.length - trail.length);
    const kind = core === "" ? null : classify(core);
    return kind === null ? token : `${hit(kind)}${trail}`;
  });
  // Word edges exclude letters, digits, apostrophes and the placeholders'
  // brackets, so a one letter name never eats part of a word or a placeholder.
  for (const name of privateNames()) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9'<])${escapeRegExp(name)}(?![A-Za-z0-9'>])`, "gi"), "<name>");
  }
  return { text: out, found };
}

export function scrub(text: string, max = DIAGNOSTIC_MAX): string {
  const out = redact(text).text;
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

// The command with its flags; a value is kept only after scrubbing, so a
// path given to --cwd, --output or --finalize never reaches the issue.
function commandLine(command: string, args: string[]): string {
  if (command === "report") return "report";
  // One argument is one value: a path with spaces in it goes whole.
  const value = (v: string): string => {
    const r = redact(v.replace(/custom:[^,\s]+/g, "custom scanner"));
    return r.found.has("a path") ? "<path>" : scrub(r.text);
  };
  const parts = args.map((arg) => {
    if (!arg.startsWith("-")) return value(arg);
    const eq = arg.indexOf("=");
    return eq === -1 ? arg : `${arg.slice(0, eq)}=${value(arg.slice(eq + 1))}`;
  });
  return [command, ...parts].join(" ");
}

function osName(): string {
  const names: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
  return names[process.platform] ?? process.platform;
}

export function composeIssue(problem: Problem, command: string, args: string[]): Issue {
  const scanners =
    run.scanners === null || run.scanners.length === 0
      ? "none ran"
      : run.scanners.map((s) => `${scannerLabel(s.scanner)} ${s.status}`).join(", ");
  const body = [
    `Command: ${commandLine(command, args)}`,
    `Component: ${problem.component}`,
    `Diagnostic: ${scrub(problem.diagnostic, problem.code === "internal-error" ? INTERNAL_MAX : DIAGNOSTIC_MAX)}`,
    `Scanners: ${scanners}`,
    `Environment: ${osName()}, ${process.arch}, Node ${process.versions.node.split(".")[0]}`,
  ].join("\n");
  return { title: `OpenQodex ${__OPENQODEX_VERSION__}: ${problem.code}`, body };
}

export function issueText(issue: Issue): string {
  return [
    "OpenQodex had a problem. Nothing has been sent.",
    `Issue title: ${issue.title}`,
    "Issue body:",
    issue.body,
    "1 create a GitHub issue",
    "2 ignore",
    "",
  ].join("\n");
}

// .openqodex/last-report.json in the repo (ignored by the folder's own
// .gitignore), or last-report.json in the OpenQodex home outside a repo. In a
// repo it is repo state: read and written only through repo-state.ts.
type LastPlace = { repoRoot: string | null; path: string };
async function lastReportPlace(cwd: string): Promise<LastPlace> {
  if (run.repoRoot === null) {
    try {
      run.repoRoot = await findRepoRoot(cwd);
    } catch {
      return { repoRoot: null, path: join(openqodexHomeDir(), LAST_REPORT) };
    }
  }
  if (run.outsideRepo) return { repoRoot: null, path: join(openqodexHomeDir(), LAST_REPORT) };
  return { repoRoot: run.repoRoot, path: join(run.repoRoot, STATE_DIR, LAST_REPORT) };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type Saved = { version: 1; title: string; body: string; created_at: string; sha256: string };

// Writes the shown issue, with the hash of the exact text shown. False when
// it could not: a link in the way, or a folder that cannot be written.
function saveLast({ repoRoot, path }: LastPlace, issue: Issue): boolean {
  try {
    const saved: Saved = { version: 1, ...issue, created_at: new Date().toISOString(), sha256: sha256(issueText(issue)) };
    const text = `${JSON.stringify(saved, null, 2)}\n`;
    if (repoRoot !== null) {
      // A state folder made here ignores itself, as every run's folder does.
      const ignore = join(STATE_DIR, ".gitignore");
      if (repoStat(repoRoot, ignore) === null) writeRepoFile(repoRoot, ignore, "*\n", { exclusive: true });
      writeRepoFile(repoRoot, path, text);
      return true;
    }
    const dir = dirname(path);
    if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
    homeGuard(openqodexHomeDir()).write(path, text);
    return true;
  } catch {
    return false;
  }
}

const TITLE = /^OpenQodex [0-9A-Za-z.+-]+: (internal-error|scanner-failed|developer-report)$/;
const BODY_LABELS = ["Command: ", "Component: ", "Diagnostic: ", "Scanners: ", "Environment: "];

// The last issue shown here, only when the file is a real file in exactly
// the saved shape and its text is the text that was shown. Else the reason.
export async function readLast(cwd: string): Promise<Issue | string> {
  const { repoRoot, path } = await lastReportPlace(cwd);
  let text: string | null;
  if (repoRoot !== null) {
    try {
      text = readRepoFile(repoRoot, path);
    } catch (error) {
      return `${(error as Error).message}; nothing was sent`;
    }
  } else {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat !== undefined && !stat.isFile()) return `${path} is not a regular file; nothing was sent`;
    text = stat === undefined ? null : readFileSync(path, "utf8");
  }
  if (text === null) return "no problem report has been shown here, so there is nothing to send";
  const changed = `${path} changed after it was shown; nothing was sent`;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return changed;
  }
  const v = value as Partial<Saved>;
  const keys = value !== null && typeof value === "object" ? Object.keys(value).sort().join(",") : "";
  if (
    keys !== "body,created_at,sha256,title,version" ||
    v.version !== 1 ||
    typeof v.title !== "string" ||
    typeof v.body !== "string" ||
    typeof v.created_at !== "string" ||
    Number.isNaN(Date.parse(v.created_at)) ||
    !TITLE.test(v.title)
  ) {
    return changed;
  }
  const lines = v.body.split("\n");
  if (lines.length !== BODY_LABELS.length || lines.some((l, i) => !l.startsWith(BODY_LABELS[i] as string))) return changed;
  const issue = { title: v.title, body: v.body };
  if (v.sha256 !== sha256(issueText(issue))) return changed;
  return issue;
}

// One key from the terminal. Anything but 1, Enter, Ctrl-C and end of input
// all mean 2.
function readKey(): Promise<string> {
  const stdin = process.stdin;
  return new Promise((done) => {
    const finish = (key: string): void => {
      stdin.removeAllListeners("data");
      stdin.removeAllListeners("end");
      stdin.setRawMode(false);
      stdin.pause();
      done(key);
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", (chunk: Buffer) => finish(chunk.toString("utf8")));
    stdin.once("end", () => finish(""));
  });
}

// Choice 1. With a signed-in GitHub CLI the issue is created as shown;
// otherwise the new-issue page opens with the same title and body filled in.
// Never signs in.
export async function sendIssue(issue: Issue): Promise<string> {
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 15_000 });
    const { stdout } = await execFileAsync(
      "gh",
      ["issue", "create", "--repo", ISSUE_REPO, "--title", issue.title, "--body", issue.body],
      { timeout: 60_000 },
    );
    return `Created ${stdout.trim()}`;
  } catch {
    // no gh, not signed in, or the create failed: the browser page instead
  }
  const url = `https://github.com/${ISSUE_REPO}/issues/new?title=${encodeURIComponent(issue.title)}&body=${encodeURIComponent(issue.body)}`;
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (opener !== null) {
    try {
      await execFileAsync(opener, [url], { timeout: 15_000 });
      return `Opened the new issue page in your browser: ${url}`;
    } catch {
      // no browser here
    }
  }
  return `Open this page to create the issue: ${url}`;
}

// Prints the issue and the two choices. On a terminal it reads one key; else
// it says how to send it later, so an agent can ask the developer.
export async function offer(problem: Problem, command: string, args: string[], cwd: string): Promise<void> {
  // Found first, so the repo's name is scrubbed from the issue too.
  const lastPath = await lastReportPlace(cwd);
  const issue = composeIssue(problem, command, args);
  process.stderr.write(issueText(issue));
  const saved = saveLast(lastPath, issue);
  if (process.stdin.isTTY && process.stderr.isTTY) {
    process.stderr.write("Choose 1 or 2: ");
    const key = await readKey();
    process.stderr.write("\n");
    if (key === "1") process.stderr.write(`${await sendIssue(issue)}\n`);
    return;
  }
  process.stderr.write(
    saved ? `To create the issue, run: ${SEND_LAST}\nTo ignore it, do nothing\n` : "the report could not be saved; nothing to send\n",
  );
}
