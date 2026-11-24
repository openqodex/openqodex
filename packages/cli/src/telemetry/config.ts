// Where the anonymous usage data goes, and whether it may go at all.
//
// enabled() is the one switch check. The command runs only rules 1 to 7,
// which read no file but the link of its own entry (envSwitch), before it
// starts the worker. The worker runs all nine before it sends, so starting
// the worker by hand gets past no switch, and the config files are read by
// the worker, never by the command. First match wins; only a clear "on" or
// an absent key leaves usage data on:
//   1  token empty, or a host that is not https (or http on loopback)  off
//   2  OPENQODEX_REVIEW_DEPTH set: a command the reviewer runs          off
//   3  any CI marker set                                                off
//   4  --offline, or OPENQODEX_OFFLINE=1                                off
//   5  OPENQODEX_TELEMETRY set to anything but 1, on or true            off
//   6  DO_NOT_TRACK set and not empty, 0 or false                       off
//   7  a local build (not the launcher, not under node_modules)         off,
//      unless OPENQODEX_TELEMETRY=1 and the host is loopback
//   8  <home>/config.yaml cannot be read, or its key is not on          off
//   9  a project config near the folder says anything but on            off
// OPENQODEX_TELEMETRY=1 lifts rule 7 and nothing else.
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { telemetrySwitch, telemetryValue } from "@openqodex/core";
import { launcherStarted } from "../launcher.js";
import { readUserConfig } from "../user-config.js";

// Moving to a relay of our own is one edit here; it takes the same /batch/ body.
export const TELEMETRY_HOST = "https://eu.i.posthog.com";
// The PostHog project token: public and write only.
export const TELEMETRY_KEY = "phc_nWno33yBVBRigpDfjYzbFmZNDTcUh79Y3MbeWt5J6j5F"; // gitleaks:allow

export const CI_MARKERS = ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "JENKINS_URL", "TF_BUILD", "TEAMCITY_VERSION", "BUILDKITE", "CODEBUILD_BUILD_ID", "BUILDER_OUTPUT"];

export type Target = { host: string; key: string; loopback: boolean };

// The host and token in force, or null when either is not allowed.
export function telemetryTarget(env: NodeJS.ProcessEnv): Target | null {
  const host = (env.OPENQODEX_TELEMETRY_HOST ?? TELEMETRY_HOST).replace(/\/+$/, "");
  const key = env.OPENQODEX_TELEMETRY_KEY ?? TELEMETRY_KEY;
  if (key === "") return null;
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  return { host, key, loopback };
}

// What the switch check needs from the command: the folder it ran in, the
// --config it was given, whether --offline was given. The worker gets the
// same as its policy context; it never enters an event.
export type PolicyContext = { cwd: string; config?: string; offline: boolean };

export type Switch = { on: boolean; why: string };

const set = (v: string | undefined): boolean => v !== undefined && v !== "";

// The entry with its links resolved: a global npm install runs through a
// link in <prefix>/bin that points into node_modules.
function realEntry(entry: string): string {
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}

// Rules 1 to 7: the environment, the command line and the entry. Null when
// none of them turns usage data off.
export function envSwitch(o: { env: NodeJS.ProcessEnv; context: PolicyContext; entry?: string }): Switch | null {
  const { env, context } = o;
  const target = telemetryTarget(env);
  if (target === null) return { on: false, why: "no allowed host or token" };
  if (set(env.OPENQODEX_REVIEW_DEPTH)) return { on: false, why: "a command the reviewer runs" };
  const ci = CI_MARKERS.find((m) => set(env[m]));
  if (ci !== undefined) return { on: false, why: `${ci} is set` };
  if (context.offline) return { on: false, why: "--offline" };
  if (env.OPENQODEX_OFFLINE === "1") return { on: false, why: "OPENQODEX_OFFLINE=1" };
  const forced = env.OPENQODEX_TELEMETRY;
  if (forced !== undefined && !["1", "on", "true"].includes(forced.trim().toLowerCase())) return { on: false, why: "OPENQODEX_TELEMETRY" };
  const dnt = env.DO_NOT_TRACK;
  if (set(dnt) && !["0", "false"].includes(dnt!.trim().toLowerCase())) return { on: false, why: "DO_NOT_TRACK" };
  const entry = o.entry ?? process.argv[1];
  const published = launcherStarted(env, entry) || (entry !== undefined && (entry.split(sep).includes("node_modules") || realEntry(entry).split(sep).includes("node_modules")));
  if (!published && !(forced !== undefined && target.loopback)) return { on: false, why: "a local build" };
  return null;
}

export function enabled(o: { env: NodeJS.ProcessEnv; home: string; context: PolicyContext; entry?: string }): Switch {
  const early = envSwitch(o);
  if (early !== null) return early;
  const { context } = o;
  const user = readUserConfig(o.home);
  if (user.error !== null) return { on: false, why: "the user config cannot be read" };
  if (user.values.openqodex_telemetry !== undefined && telemetryValue(user.values.openqodex_telemetry) !== "on") {
    return { on: false, why: "openqodex_telemetry in the user config" };
  }
  const project = telemetrySwitch(context.cwd, context.config);
  if (!project.on) return { on: false, why: project.why ?? "the project config" };
  return { on: true, why: "default" };
}
