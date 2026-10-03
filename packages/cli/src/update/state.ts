// The self-update's state, <home>/update.json: a cache for the status lines
// and the notices, never read for a safety decision. Each write is a temp
// file then a rename; when two processes write at once the last one wins,
// and the worst a lost write costs is one extra check or one missed notice.
// Unreadable state reads as empty. The switch is the user config file
// below, and it fails safe: a config that does not parse turns updating off.
import { join } from "node:path";
import { parseDocument } from "yaml";
import { readText, sha256, writeAtomic } from "../agents/files.js";

export type UpdateState = {
  // When a worker last started a check (ISO time); the trigger waits 24 hours after it.
  checkedAt: string | null;
  // The registry's latest version at the last check that reached it.
  latestSeen: string | null;
  // Releases that failed verification or could not be activated, with when.
  skipped: { version: string; reason: string; at: string }[];
  lastError: string | null;
  // One line for the next command run by `version` to print, then cleared.
  notice: { version: string; text: string } | null;
  // The sha256 of a config.yaml that `update` created, so uninstall removes
  // it only while it is unchanged.
  userConfig: string | null;
};

export function emptyState(): UpdateState {
  return { checkedAt: null, latestSeen: null, skipped: [], lastError: null, notice: null, userConfig: null };
}

export function statePath(home: string): string {
  return join(home, "update.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function readState(home: string): UpdateState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(statePath(home)) ?? "null");
  } catch {
    return emptyState();
  }
  if (!isObject(parsed)) return emptyState();
  const skipped = Array.isArray(parsed.skipped)
    ? parsed.skipped.filter(isObject).flatMap((s) =>
        typeof s.version === "string" && typeof s.reason === "string" && typeof s.at === "string" ? [{ version: s.version, reason: s.reason, at: s.at }] : [],
      )
    : [];
  const n = parsed.notice;
  return {
    checkedAt: str(parsed.checkedAt),
    latestSeen: str(parsed.latestSeen),
    skipped,
    lastError: str(parsed.lastError),
    notice: isObject(n) && typeof n.version === "string" && typeof n.text === "string" ? { version: n.version, text: n.text } : null,
    userConfig: str(parsed.userConfig),
  };
}

// Reads, changes and writes the state. Not locked: see the top of this file.
export function updateState(home: string, change: Partial<UpdateState>): void {
  writeAtomic(statePath(home), `${JSON.stringify({ ...readState(home), ...change }, null, 2)}\n`, 0o600);
}

// ---------- the user-level config, <home>/config.yaml ----------

export function userConfigPath(home: string): string {
  return join(home, "config.yaml");
}

type UserConfig = { ok: true; update: "on" | "off" | null; raw: string | null } | { ok: false; reason: string };

function readUserConfig(home: string): UserConfig {
  let raw: string | null;
  try {
    raw = readText(userConfigPath(home));
  } catch {
    return { ok: false, reason: `${userConfigPath(home)} cannot be read` };
  }
  if (raw === null) return { ok: true, update: null, raw };
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) return { ok: false, reason: `${userConfigPath(home)} does not parse` };
  const data: unknown = doc.toJS();
  if (data === null || data === undefined) return { ok: true, update: null, raw };
  if (!isObject(data)) return { ok: false, reason: `${userConfigPath(home)} is not a mapping` };
  const value = data.update;
  if (value === undefined) return { ok: true, update: null, raw };
  if (value === "on" || value === true) return { ok: true, update: "on", raw };
  if (value === "off" || value === false) return { ok: true, update: "off", raw };
  return { ok: false, reason: `update in ${userConfigPath(home)} is neither on nor off` };
}

// Whether a worker may check and install now, and the reason when not.
export function updatesAllowed(home: string, env: NodeJS.ProcessEnv): { allowed: boolean; why: string } {
  if (env.CI !== undefined && env.CI !== "") return { allowed: false, why: "off: CI is set" };
  if (env.OPENQODEX_OFFLINE === "1") return { allowed: false, why: "off: offline (--offline or OPENQODEX_OFFLINE=1)" };
  if (env.OPENQODEX_AUTO_UPDATE === "0") return { allowed: false, why: "off: OPENQODEX_AUTO_UPDATE=0" };
  const config = readUserConfig(home);
  if (!config.ok) return { allowed: false, why: `off: ${config.reason}` };
  if (config.update === "off") return { allowed: false, why: `off: update: off in ${userConfigPath(home)}` };
  return { allowed: true, why: "on" };
}

// Sets `update:` in the user config, keeping every other key and comment.
// Refuses a config that does not parse rather than overwrite it. A file this
// created, and changed only by this since, is remembered in update.json so
// uninstall removes it; a file the developer wrote is never remembered.
export function setUserUpdate(home: string, value: "on" | "off"): void {
  const config = readUserConfig(home);
  if (!config.ok) throw new Error(`${config.reason}; fix or remove it first`);
  const ours = config.raw === null || readState(home).userConfig === sha256(config.raw);
  const doc = parseDocument(config.raw ?? "");
  let text: string;
  if (doc.contents === null) text = `update: ${value}\n`;
  else {
    doc.set("update", value);
    text = String(doc);
  }
  writeAtomic(userConfigPath(home), text);
  if (ours) updateState(home, { userConfig: sha256(text) });
}
