// The command's side of the anonymous usage data. Code records events into
// a list in memory; dispatch() checks the switches, stamps the install id,
// and hands the list to a detached worker, which makes the one request.
// Everything here is synchronous: no await, no timer, no socket. Nothing
// here throws, changes the exit code or prints anything.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { parse, resolve } from "node:path";
import { openqodexHome } from "@openqodex/scanners";
import { hostAgent } from "@openqodex/review";
import { launcherStarted } from "../launcher.js";
import { HANDED_OFF } from "../update/trigger.js";
import { enabled, type PolicyContext } from "./config.js";
import { commandProps, commonProps, validate, type EventName } from "./events.js";
import { ageDays, createId, installId, readId } from "./identity.js";

// The most a worker is handed.
export const MAX_EVENTS = 8;
export const MAX_BYTES = 16_000;

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
  const handedOff = args.includes(HANDED_OFF);
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

export function record(event: EventName, props: Record<string, unknown>): void {
  if (run === null || run.silent) return;
  pending.push({ event, props, timestamp: new Date().toISOString() });
}

function context(args: string[]): PolicyContext {
  const at = (name: string): string | undefined => {
    const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (i === -1) return undefined;
    return args[i]!.startsWith(`${name}=`) ? args[i]!.slice(name.length + 1) : args[i + 1];
  };
  const cwd = resolve(at("--cwd") ?? process.cwd());
  const config = at("--config");
  return { cwd, ...(config !== undefined ? { config } : {}), offline: args.includes("--offline") };
}

// The command event, recorded once: by the closure when the command
// returns or throws, or by the Ctrl-C path of a review.
export function recordCommand(o: { exitCode: number; error?: unknown; threw: boolean; interrupted: boolean }): void {
  if (run === null || run.silent || run.commandSent || run.handedOff) return;
  run.commandSent = true;
  record("command.completed", commandProps({ command: run.command, args: run.args, sub: run.sub, exitCode: o.exitCode, durationMs: Date.now() - run.started, error: o.error, threw: o.threw, interrupted: o.interrupted }));
}

export function dispatch(): void {
  try {
    const r = run;
    const events = pending;
    pending = [];
    if (r === null || r.silent || events.length === 0) return;
    const ctx = context(r.args);
    const home = openqodexHome();
    if (!enabled({ env: process.env, home, context: ctx }).on) return;
    let id = readId(home);
    if (id === "bad") return;
    if (id === null) {
      if (!r.mayCreate) return;
      const made = createId(home);
      if (made === null) return;
      id = made.id;
      if (made.created) events.unshift({ event: "install.first_use", props: {}, timestamp: new Date().toISOString() });
    }
    const distinct = installId(id);
    const common = commonProps({ installId: distinct, ageDays: ageDays(id), hostAgent: hostAgent(process.env), launcher: launcherStarted(), env: process.env });
    const batch = events
      .slice(0, MAX_EVENTS)
      .map((e) => validate({ uuid: randomUUID(), event: e.event, distinct_id: distinct, timestamp: e.timestamp, properties: { ...common, ...e.props } }))
      .filter((e) => e !== null);
    let json = JSON.stringify(batch);
    if (json.length > MAX_BYTES) {
      for (const e of batch) {
        delete e.properties.scannerMs;
        delete e.properties.scannerFailures;
      }
      json = JSON.stringify(batch);
      if (json.length > MAX_BYTES) return;
    }
    if (batch.length === 0) return;
    const entry = process.argv[1];
    if (entry === undefined) return;
    const child = spawn(process.execPath, [resolve(entry), "__telemetry"], {
      cwd: parse(home).root || "/",
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, OPENQODEX_TELEMETRY_EVENTS: json, OPENQODEX_TELEMETRY_CONTEXT: JSON.stringify(ctx) },
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
