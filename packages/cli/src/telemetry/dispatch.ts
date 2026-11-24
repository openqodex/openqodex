// The command's side of the anonymous usage data. Code records events into
// a list in memory; dispatch() checks the switches that need no file and
// hands the list to a detached worker. The worker reads the config files and
// the install id, makes the id on a first run, and makes the one request.
// Everything here is synchronous: no await, no timer, no socket, no file
// read or written but the link of the entry. Nothing here throws, changes
// the exit code or prints anything.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { parse, resolve } from "node:path";
import { openqodexHome } from "@openqodex/scanners";
import { hostAgent } from "@openqodex/review";
import { launcherStarted } from "../launcher.js";
import { HANDED_OFF } from "../update/trigger.js";
import { enabled, envSwitch, type PolicyContext } from "./config.js";
import { commandProps, commonProps, validate, type EventName } from "./events.js";

// The most a worker is handed.
export const MAX_EVENTS = 8;
export const MAX_BYTES = 16_000;

// What the worker is handed besides the events: the policy context, and
// whether this command may make the install id.
export type WorkerContext = PolicyContext & { mayCreate: boolean };

// The distinct id the command validates with; the worker puts the hash of
// the install id in its place. It has the same length, so the size check
// here holds for the request.
export const UNSTAMPED = "0".repeat(64);

type Pending = { event: EventName; props: Record<string, unknown>; timestamp: string };

type Run = {
  command: string;
  args: string[];
  started: number;
  // Nothing at all is read, written or sent for this command line (rule 0).
  silent: boolean;
  // Whether this command may create the install id.
  mayCreate: boolean;
  // A finalize another openqodex started: it sends its review event only.
  handedOff: boolean;
  sub?: string;
  commandSent: boolean;
};

let run: Run | null = null;
let pending: Pending[] = [];

// Rule 0: hook check, mcp, a hidden worker, any --dry-run, init --uninstall.
export function silentCommand(command: string, args: string[]): boolean {
  if (command === "mcp" || command.startsWith("__")) return true;
  if (command === "hook" && args[0] === "check") return true;
  if (args.includes("--dry-run")) return true;
  if (command === "init" && args.includes("--uninstall")) return true;
  return false;
}

// Called at the top of every command's action.
export function begin(command: string, args: string[], started = Date.now()): void {
  // Only a review's own flag: words after `--` are a path or report text.
  const flags = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  const handedOff = command === "review" && flags.includes(HANDED_OFF);
  run = { command, args, started, silent: silentCommand(command, args), mayCreate: command !== "init" && command !== "hook" && !handedOff, handedOff, commandSent: false };
  pending = [];
}

// init may create the id once the developer agreed to the install.
export function permitId(): void {
  if (run !== null) run.mayCreate = true;
}

// The sub-command word, for a command whose arguments alone do not say it.
export function noteSub(sub: string): void {
  if (run !== null) run.sub = sub;
}

// `props` is a function, called here inside a try, so building an event
// never throws into the command and never runs for a silent command.
export function record(event: EventName, props: () => Record<string, unknown>): void {
  if (run === null || run.silent) return;
  try {
    pending.push({ event, props: props(), timestamp: new Date().toISOString() });
  } catch {
    // An event that cannot be built is dropped.
  }
}

// The folder, --config and --offline the command acts on, read the way
// parseFlags reads them (flags.ts): flags end at `--`, the last value of a
// flag wins, and a value is `--name=value` or the next word. In a command
// line parseFlags accepts, a word `--cwd` is always the flag itself, since
// it refuses a value that starts with `--`.
export function context(args: string[]): PolicyContext {
  const flags = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  const last = (name: string): string | undefined => {
    let value: string | undefined;
    for (let i = 0; i < flags.length; i++) {
      const a = flags[i]!;
      if (a === name) value = flags[++i];
      else if (a.startsWith(`${name}=`)) value = a.slice(name.length + 1);
    }
    return value === "" ? undefined : value;
  };
  const cwd = resolve(last("--cwd") ?? process.cwd());
  const config = last("--config");
  return { cwd, ...(config !== undefined ? { config } : {}), offline: flags.includes("--offline") };
}

// The command event, recorded once: by the closure when the command
// returns or throws, or by the Ctrl-C path of a review.
export function recordCommand(o: { exitCode: number; error?: unknown; threw: boolean; interrupted: boolean }): void {
  if (run === null || run.silent || run.commandSent || run.handedOff) return;
  run.commandSent = true;
  const r = run;
  record("command.completed", () => commandProps({ command: r.command, args: r.args, sub: r.sub, exitCode: o.exitCode, durationMs: Date.now() - r.started, error: o.error, threw: o.threw, interrupted: o.interrupted }));
}

export function dispatch(): void {
  try {
    const r = run;
    const events = pending;
    pending = [];
    if (r === null || r.silent || events.length === 0) return;
    const ctx = context(r.args);
    if (envSwitch({ env: process.env, context: ctx }) !== null) return;
    const common = commonProps({ hostAgent: hostAgent(process.env), launcher: launcherStarted(), env: process.env });
    const batch = events
      .slice(0, MAX_EVENTS)
      .map((e) => validate({ uuid: randomUUID(), event: e.event, distinct_id: UNSTAMPED, timestamp: e.timestamp, properties: { ...common, ...e.props } }))
      .filter((e) => e !== null);
    let json = JSON.stringify(batch);
    // Room for the install.first_use the worker may add.
    const room = MAX_BYTES - 1000;
    if (json.length > room) {
      for (const e of batch) {
        delete e.properties.scannerMs;
        delete e.properties.scannerFailures;
      }
      json = JSON.stringify(batch);
      if (json.length > room) return;
    }
    if (batch.length === 0) return;
    const entry = process.argv[1];
    if (entry === undefined) return;
    const home = openqodexHome();
    const worker: WorkerContext = { ...ctx, mayCreate: r.mayCreate };
    const child = spawn(process.execPath, [resolve(entry), "__telemetry"], {
      cwd: parse(home).root || "/",
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, OPENQODEX_HOME: home, OPENQODEX_TELEMETRY_EVENTS: json, OPENQODEX_TELEMETRY_CONTEXT: JSON.stringify(worker) },
    });
    child.once("error", () => undefined);
    child.unref();
  } catch {
    // Usage data is never a reason for a command to fail.
  }
}

// Whether usage data is on here, and why, for doctor.
export function telemetryStatus(args: string[]): { on: boolean; why: string } {
  try {
    return enabled({ env: process.env, home: openqodexHome(), context: context(args) });
  } catch {
    return { on: false, why: "the switches cannot be read" };
  }
}
