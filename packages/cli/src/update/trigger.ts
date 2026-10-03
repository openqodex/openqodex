// What runs after every command: the one-line notices on stderr, and the
// start of a detached update worker after `review`, `scan`, `hook check` and
// `hook pre-push` run through the launcher. It reads two small files and at
// most spawns a process: no timer, no network, no lock wait. It never throws
// and never touches the exit code or stdout.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { openqodexHome } from "@openqodex/scanners";
import { launcherStarted } from "../launcher.js";
import { readState, updateState, updatesAllowed, type UpdateState } from "./state.js";

// The hidden argument a finalize handoff passes to the runtime that wrote the brief.
export const HANDED_OFF = "--handed-off";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = DAY_MS;

function ageMs(iso: string | null, now: number): number {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

function days(ms: number): string {
  const n = Math.floor(ms / DAY_MS);
  return n === 0 ? "today" : n === 1 ? "1 day ago" : `${n} days ago`;
}

// For a pinned run (npx, a project-scope file): one line when the state a
// launcher install left says a newer version is out. Nothing without state.
export function pinnedNote(state: UpdateState, running: string, now = Date.now()): string | null {
  if (state.latestSeen === null || !newer(state.latestSeen, running)) return null;
  return `the pinned version ${running} is behind ${state.latestSeen} (seen at the last check, ${days(ageMs(state.checkedAt, now))})`;
}

// Starts the worker when a check is due, exactly as the scanner installs start
// theirs: detached, no stdio, spawn errors swallowed, unref'd.
export function maybeStartUpdate(home: string, state: UpdateState): void {
  if (!updatesAllowed(home, process.env).allowed) return;
  // A check time in the future (a clock that moved back) counts as due.
  const age = ageMs(state.checkedAt, Date.now());
  if (age >= 0 && age < CHECK_EVERY_MS) return;
  const entry = process.argv[1];
  if (entry === undefined) return;
  const child = spawn(process.execPath, [resolve(entry), "__update"], {
    cwd: homedir(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OPENQODEX_HOME: home },
  });
  child.once("error", () => undefined);
  child.unref();
}

// The pending notice, printed once by the version it is for, then cleared.
// update.json is not locked: two commands at once may both print it.
function notices(home: string, state: UpdateState): void {
  if (state.notice === null || state.notice.version !== __OPENQODEX_VERSION__) return;
  process.stderr.write(`${state.notice.text}\n`);
  updateState(home, { notice: null });
}

export function afterCommand(name: string, args: string[]): void {
  try {
    // A finalize handed to the runtime that wrote the brief: its parent speaks.
    if (args.includes(HANDED_OFF)) return;
    const home = openqodexHome();
    const state = readState(home);
    const sub = name === "hook" ? args[0] : undefined;
    if (!launcherStarted()) {
      const note = name === "review" || name === "scan" ? pinnedNote(state, __OPENQODEX_VERSION__) : null;
      if (note !== null) process.stderr.write(`openqodex: ${note}\n`);
      return;
    }
    // The agent hook's stderr is not shown on success, so a notice there
    // would be marked as seen without being seen.
    if (!(name === "hook" && sub === "check")) notices(home, state);
    // --offline is read from the arguments too: it counts even where the
    // command's own flag parsing never reached it.
    if (args.includes("--offline")) return;
    if (name === "review" || name === "scan" || (name === "hook" && (sub === "check" || sub === "pre-push"))) maybeStartUpdate(home, state);
  } catch {
    // Updating is never a reason for a command to fail.
  }
}
