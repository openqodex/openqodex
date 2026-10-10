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
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ReviewerUsage } from "@openqodex/core";
import type { CallRecord, ToolLogEntry } from "../usage.js";
import type { OwnFiles, ToolCall } from "./trace.js";

// Set in every reviewer's environment. A `review` that starts with it set
// refuses: a review never starts another review.
export const DEPTH_ENV = "OPENQODEX_REVIEW_DEPTH";

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
  start(opts: { snapshotDir: string; deadline: number; bin: string; web: boolean }): ReviewerSession;
}

// Spawned without a shell, as the leader of a new process group, so the
// whole group can be killed at once.
export function spawnGroup(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true, shell: false });
}

export function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
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

// The first executable `name` on PATH, from absolute entries only, as its
// real path. An entry is skipped when the folder, the file, or any link on
// the way from one to the other resolves inside one of the `forbidden`
// folders (the repository, the review snapshots), so a repository cannot put
// its own program in the reviewer's place through a link or a folder name.
export function findOnPath(name: string, forbidden: string[], path = process.env.PATH ?? ""): string | null {
  const roots: string[] = [];
  for (const f of forbidden) {
    try {
      roots.push(real(f));
    } catch {
      roots.push(FOLD_CASE ? f.toLowerCase() : f);
    }
  }
  const owned = (p: string) => roots.some((r) => inside(r, p));
  for (const dir of path.split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    try {
      let hop = join(dir, name);
      if (!existsSync(hop)) continue;
      let safe = true;
      for (let n = 0; n < MAX_HOPS && safe; n++) {
        // Each hop's folder resolved, the name kept: the link itself is checked.
        if (owned(join(real(dirname(hop)), FOLD_CASE ? basename(hop).toLowerCase() : basename(hop)))) safe = false;
        if (!lstatSync(hop).isSymbolicLink()) break;
        hop = resolve(dirname(hop), readlinkSync(hop));
      }
      const bin = realpathSync.native(join(dir, name));
      if (!safe || owned(real(bin))) continue;
      const st = statSync(bin);
      if (st.isFile() && (st.mode & 0o111) !== 0) return bin;
    } catch {
      // unreadable entry: try the next
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
