// The reviewer driver seam. A driver starts one coding agent as a separate
// process, with no window, to review one snapshot: it says whether its agent
// is installed and logged in, starts it without a shell in a process group of
// its own, hands it text and returns the agent's final answer with the trace
// of every tool call the agent reported. Nothing a driver returns is trusted
// as a claim: the run checks the trace and the answer with scripts.
//
// Claude Code (claude.ts) and Codex (codex.ts) are enabled. Cursor
// (cursor.ts) failed checks with its real binary and says so from detect();
// docs/internal-reviewer-drivers.md records the runs. A driver is enabled
// once its isolation was shown with the real binary.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import type { ReviewerUsage } from "@openqodex/core";
import { redactSecrets } from "@openqodex/core";
import type { CallRecord, ToolLogEntry } from "../usage.js";
import type { OwnFiles, ToolCall } from "./trace.js";

// Set in every reviewer's environment. A `review` that starts with it set
// refuses: a review never starts another review.
export const DEPTH_ENV = "OPENQODEX_REVIEW_DEPTH";

// The failure of a turn the review's deadline stopped, whichever stop fired
// first: the driver's, the conversation's or the model loop's. The
// conversation reports it as the host words it (ReviewInputs.timedOut).
export const TIMED_OUT = "the reviewer timed out and was stopped";

// What a program on Windows needs beside a driver's own allowlist: the home
// folder, the app data folders, the system folder, the temporary folder,
// and how programs are named and started.
const WINDOWS_ENV = ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "PATHEXT", "COMSPEC", "TEMP", "TMP"];

// `name` is on the allowlist `names`. On Windows a variable's name has no
// case (Node lists the path as `Path`), so the match ignores case there and
// the Windows variables above are added.
export function onAllowlist(names: string[], name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return names.includes(name);
  const upper = name.toUpperCase();
  return [...names, ...WINDOWS_ENV].some((n) => n.toUpperCase() === upper);
}

// The words a reviewer uses when its login ran out of use: Claude Code's
// "You've hit your limit" and "usage limit reached", Codex's "You've hit
// your usage limit". A rate limit is a short wait instead, and checked first.
const RATE_LIMIT = /rate limit|rate_limit|too many requests|\bHTTP 429\b/i;
const PLAN_LIMIT = /usage limit|plan limit|limit reached|hit your (\S+ )?limit/i;

// The failure of a turn the reviewer itself ended with an error, from the
// reviewer's own message, so the receipt says what happened and, for a
// limit, when it resets, also when the reset is on a later line. The
// scanners' `secrets` are removed first, while the message is whole; then
// it is put on one line and cut at 200 characters. `fallback` stands in
// when the reviewer sent no message.
export function reviewerError(message: string | null, fallback = "unknown", secrets: string[] = []): string {
  const whole = message === null ? "" : redactSecrets(message, secrets).replace(/\s+/g, " ").trim();
  const said = whole.slice(0, 200) || fallback;
  if (RATE_LIMIT.test(whole)) return `the reviewer hit a rate limit (${said})`;
  return PLAN_LIMIT.test(whole) ? `the reviewer hit its usage or plan limit (${said})` : `the reviewer stopped with an error (${said})`;
}

// The failure names a rate, usage or plan limit (reviewerError).
export function namesLimit(failure: string): boolean {
  return failure.startsWith("the reviewer hit ");
}

export type Detected = { ok: true; version: string; bin: string } | { ok: false; missing: string; fix: string };

// One answer of the reviewer. `usage` is the session's total so far.
// `failure` is one plain line when the agent could not answer (it exited,
// it timed out, it started with more than it was given).
// `calls`: every tool call of this answer, as the agent sent it; the run
// decides from them, by script, what was read and where.
// `models`: the model names the agent itself reported with the answer
// (Claude Code's modelUsage); absent when the driver cannot name one.
// `own`: where the agent saves its own output for this session, so a call on
// it is not taken for a read of the repository; left out when the driver
// knows of no such place.
// `brain`: set only on a model reviewer's turn (model-loop.ts), where the
// brain ran every tool itself: `trace` is its own log of this turn's tool
// calls, already checked, taken in place of `calls`; `attempts` are this
// turn's model attempts; `sent` says whether the turn's text reached the
// model in a request that was invoked.
export type Turn = {
  finalText: string;
  calls: ToolCall[];
  usage: ReviewerUsage;
  sessionId: string | null;
  failure: string | null;
  models?: string[];
  own?: OwnFiles | null;
  brain?: { trace: ToolLogEntry[]; attempts: CallRecord[]; sent: boolean };
};

// An open reviewer. `send` asks for one answer in the same session: the
// brief first, then each correction round. A driver whose agent cannot keep a
// session open starts a new process per send and attaches what it needs.
export interface ReviewerSession {
  readonly pid: number | null;
  send(text: string): Promise<Turn>;
  // Ends the process and every child it started.
  close(): Promise<void>;
  // The same at once and synchronously, for a signal handler that exits
  // right after it: the whole process group is killed.
  kill?(): void;
}

export type StartOptions = { snapshotDir: string; deadline: number; bin: string; web: boolean; model?: string | null; effort?: string | null; secrets?: string[] };

export interface ReviewerDriver {
  readonly name: string;
  // True when the agent's event stream shows every tool call, so the run can
  // count reads and check each path from it (Claude Code). False when it
  // does not (Codex): the reported calls are a diagnostic list only, the
  // agent's own sandbox is the boundary, and coverage counts only what the
  // brief and the correction rounds put in front of the reviewer.
  readonly traced: boolean;
  // `repoRoot`: a program that resolves inside it, or inside the review
  // snapshots, is never run (findOnPath), so a repository cannot put its own
  // program in the reviewer's place.
  detect(repoRoot: string): Promise<Detected>;
  // Run once the snapshot exists and before `start`: a reason in one line
  // when the agent's boundary could not be shown for this run, so the
  // reviewer must not start (Codex's per-run sandbox probe). Null to go on.
  // `register` receives a synchronous cleanup while the check runs (and null
  // after), which the run's signal handler calls before it exits.
  check?(opts: { snapshotDir: string; bin: string; register: (cleanup: (() => void) | null) => void }): Promise<string | null>;
  // `deadline`: epoch milliseconds after which the process group is killed.
  // `web`: the agent gets its web tools (on unless reviewer_web: off).
  // `model` and `effort`: the model and reasoning effort to ask for; left
  // out or null, the agent's own default. Only Codex is given them.
  // `secrets`: what the scanners found, removed from the agent's own error
  // text before it is cut.
  start(opts: StartOptions): ReviewerSession;
}

const NODE_SCRIPT = [".js", ".cjs", ".mjs"];

// The program a .cmd or .bat shim npm wrote wraps: a Node script or a .exe,
// as the path the shim names. Node refuses to start the shim itself without
// a shell (EINVAL), and through cmd.exe the arguments (the settings JSON,
// with its quotes and braces) would be parsed again, and the shim would look
// for `node` in the review copy before PATH. A shim that names neither is
// refused, in a line that says what to do.
function shimTarget(shim: string): string {
  // npm: `"%dp0%\node_modules\pkg\cli.js" %*`, or `"%~dp0\...\x.exe" %*`.
  const wrapped = [...readFileSync(shim, "utf8").matchAll(/"%~?dp0%?\\([^"%]+)"\s*%\*/g)].at(-1)?.[1];
  const target = wrapped === undefined ? null : join(dirname(shim), ...wrapped.split(/[\\/]/));
  if (target !== null && [...NODE_SCRIPT, ".exe", ".com"].includes(extname(target).toLowerCase())) return target;
  throw new Error(`${shim} is a .cmd file that names no program openqodex can start; install the reviewer's .exe or with npm, or review from WSL`);
}

// How to start `bin` with `args`. On Windows findOnPath gives, for a shim,
// the Node script it wraps, which runs with this Node; a shim given here is
// read for its program the same way.
export function launch(bin: string, args: string[], platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform !== "win32") return [bin, args];
  const program = /\.(cmd|bat)$/i.test(bin) ? shimTarget(bin) : bin;
  return NODE_SCRIPT.includes(extname(program).toLowerCase()) ? [process.execPath, [program, ...args]] : [program, args];
}

// Spawned without a shell, as the leader of a new process group, so the
// whole group can be killed at once. Windows has no process groups (the
// whole tree is stopped there by taskkill), and a detached child there gets
// a console window of its own, so it is not detached there.
export function spawnGroup(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }, platform: NodeJS.Platform = process.platform): ChildProcess {
  const [file, argv] = launch(cmd, args, platform);
  return spawn(file, argv, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: platform !== "win32", windowsHide: true, shell: false });
}

// taskkill on `pid` and every process it started (/T), at once (/F), by its
// absolute path in the system folder: a bare name is looked for in the
// current folder first, which may be the repository.
export function windowsStop(pid: number, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  const root = Object.entries(env).find(([k]) => k.toUpperCase() === "SYSTEMROOT")?.[1];
  return [win32.join(root !== undefined && win32.isAbsolute(root) ? root : "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"]];
}

// Why taskkill did not stop the tree, or null when it did. Exit 128 is "no
// such process": the tree is gone already.
export function taskkillFailure(r: { status: number | null; error?: Error }): string | null {
  if (r.error !== undefined) return r.error.message.split("\n")[0] ?? "taskkill failed";
  return r.status === 0 || r.status === 128 ? null : `taskkill exited ${r.status ?? "on a signal"}`;
}

const TASKKILL_TIMEOUT_MS = 10_000;

// On Windows, the processes a reviewer started and left running after it
// exited are not stopped: taskkill finds a tree by its live parent, and
// Windows has no process group to name them by.
export function killGroup(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  if (child.pid === undefined) return;
  if (platform === "win32") {
    // Once it exited, Windows may give its id to another process, and
    // taskkill would stop that one.
    if (child.exitCode !== null || child.signalCode !== null) return;
    const [file, args] = windowsStop(child.pid);
    const failed = taskkillFailure(spawnSync(file, args, { stdio: "ignore", windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }));
    if (failed !== null) {
      // The reviewer itself at least, so its run ends.
      child.kill("SIGKILL");
      process.stderr.write(`openqodex: taskkill could not stop the reviewer (process ${child.pid}): ${failed}; the reviewer alone was stopped, and programs it started may still run\n`);
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is gone already.
  }
}

const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";
const MAX_HOPS = 40;

function real(path: string): string {
  const r = realpathSync.native(path);
  return FOLD_CASE ? r.toLowerCase() : r;
}

// `path` is `root` or below it, compared by whole path components: a
// sibling named `..tools` is below the root, not above it.
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

// What Windows starts by itself. PATHEXT may list more (.JS, .VBS), which
// need a program of their own.
const WINDOWS_STARTS = [".com", ".exe", ".bat", ".cmd"];

// The first executable `name` on PATH, from absolute entries only, as its
// real path. On Windows a program's name carries an extension: each one of
// PATHEXT that Windows starts is tried, in PATHEXT's order, and Node reports
// no execute bit there. An entry is skipped when the folder, the file, or any link on
// the way from one to the other resolves inside one of the `forbidden`
// folders (the repository, the review snapshots), so a repository cannot put
// its own program in the reviewer's place through a link or a folder name.
// For a Windows shim, what runs is the program it wraps: that program gets
// the same checks and is what is returned, and a shim whose program is gone
// or fails them is passed over.
export function findOnPath(name: string, forbidden: string[], path = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform, pathext = process.env.PATHEXT ?? ""): string | null {
  const roots: string[] = [];
  for (const f of forbidden) {
    try {
      roots.push(real(f));
    } catch {
      roots.push(FOLD_CASE ? f.toLowerCase() : f);
    }
  }
  const owned = (p: string) => roots.some((r) => inside(r, p));
  const windows = platform === "win32";
  const p = windows ? win32 : posix;
  const exts = (pathext || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase()).filter((e) => WINDOWS_STARTS.includes(e));
  const names = windows ? exts.map((e) => name + e) : [name];
  // `candidate` as its real path when it is a file that neither resolves
  // inside a forbidden folder nor reaches one through a link; else null.
  const vetted = (candidate: string): string | null => {
    let hop = candidate;
    if (!existsSync(hop)) return null;
    let safe = true;
    for (let n = 0; n < MAX_HOPS && safe; n++) {
      // Each hop's folder resolved, the name kept: the link itself is checked.
      if (owned(join(real(dirname(hop)), FOLD_CASE ? basename(hop).toLowerCase() : basename(hop)))) safe = false;
      if (!lstatSync(hop).isSymbolicLink()) break;
      hop = resolve(dirname(hop), readlinkSync(hop));
    }
    const bin = realpathSync.native(candidate);
    if (!safe || owned(real(bin))) return null;
    return statSync(bin).isFile() ? bin : null;
  };
  for (const dir of path.split(p.delimiter)) {
    if (dir === "" || !p.isAbsolute(dir)) continue;
    for (const file of names) {
      try {
        const bin = vetted(join(dir, file));
        if (bin === null) continue;
        if (!windows) {
          if ((statSync(bin).mode & 0o111) !== 0) return bin;
          continue;
        }
        if (!/\.(cmd|bat)$/i.test(bin)) return bin;
        // shimTarget throws for a shim that names no program it can start.
        const target = vetted(shimTarget(bin));
        if (target !== null) return target;
      } catch {
        // unreadable entry: try the next
      }
    }
  }
  return null;
}

// The reviewers `--reviewer` accepts, besides `auto`.
export const REVIEWER_NAMES = ["claude", "codex", "cursor"] as const;

// The agent running this command, when its environment says so. Claude Code
// sets CLAUDECODE=1 for its commands; Codex sets CODEX_THREAD_ID (seen with
// codex-cli 0.160.0); Cursor sets CURSOR_AGENT in its agent's shell (the
// marker the skills CLI reads). `review` tries this agent first, and `init`
// takes it as consent to its defaults when there is no terminal.
export function hostAgent(env: NodeJS.ProcessEnv = process.env): (typeof REVIEWER_NAMES)[number] | null {
  if (env.CLAUDECODE === "1") return "claude";
  if (env.CODEX_THREAD_ID) return "codex";
  if (env.CURSOR_AGENT) return "cursor";
  return null;
}
