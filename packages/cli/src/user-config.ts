// The user config, <openqodex home>/config.yaml: what is the developer's,
// not the team's. Every command reads it through readUserConfig, so a key
// is named the same way everywhere and a typo is never taken for a default.
//
//   update: on | off              the daily check for a new release (on)
//   skip_version: <x.y.z>         a release `update --rollback` left: the
//                                 update never installs it or an older one
//
// reviewer, reviewer_web, reviewer_model and reviewer_effort were read up to
// 0.23.0; each project's .openqodex/config.yaml chooses its reviewer now.
// They stay known keys, read only to name them in one warning
// (reviewers/settings.ts), so a file that still holds them never pauses
// automatic updates.
//
// A key this version does not know is named with the known key nearest to
// it. While one is there, automatic updates pause (update/state.ts): the key
// may be a misspelled `update: off`, or a setting of a newer version this
// one cannot honour.
import { join } from "node:path";
import { isScalar, parseDocument, type Document } from "yaml";
import { nearestName } from "@openqodex/core";
import { readText } from "./agents/files.js";

export const USER_KEYS = ["update", "reviewer", "reviewer_web", "reviewer_model", "reviewer_effort", "skip_version"] as const;
export type UserKey = (typeof USER_KEYS)[number];

export type UserConfig = {
  path: string;
  // The file's text; null when there is no file.
  raw: string | null;
  // Why the file cannot be used at all: it cannot be read, is not YAML, or
  // is not a mapping of keys to values.
  error: string | null;
  // The value of each known key, as written.
  values: Partial<Record<UserKey, unknown>>;
  // The keys this version does not know, each with the nearest known key.
  unknown: { key: string; nearest: string | null }[];
};

export function userConfigPath(home: string): string {
  return join(home, "config.yaml");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The known key a misspelled one most likely meant (core's nearestName).
export function nearestKey(key: string, known: readonly string[] = USER_KEYS): string | null {
  return nearestName(key, known);
}

export function readUserConfig(home: string): UserConfig {
  const path = userConfigPath(home);
  const none = { values: {}, unknown: [] };
  let raw: string | null;
  try {
    raw = readText(path);
  } catch {
    return { path, raw: null, error: `${path} cannot be read`, ...none };
  }
  if (raw === null) return { path, raw, error: null, ...none };
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) return { path, raw, error: `${path} does not parse as YAML`, ...none };
  const data: unknown = doc.toJS();
  if (data === null || data === undefined) return { path, raw, error: null, ...none };
  if (!isObject(data)) return { path, raw, error: `${path} is not a list of keys and values`, ...none };
  const values: Partial<Record<UserKey, unknown>> = {};
  const unknown: UserConfig["unknown"] = [];
  for (const [key, value] of Object.entries(data)) {
    if ((USER_KEYS as readonly string[]).includes(key)) values[key as UserKey] = value;
    else unknown.push({ key, nearest: nearestKey(key) });
  }
  return { path, raw, error: null, values, unknown };
}

// "unknown key reviewer-web in <path> (did you mean reviewer_web?)", or for
// more than one, "unknown keys a (did you mean b?), c in <path>".
export function unknownKeys(config: UserConfig): string | null {
  const hint = (u: UserConfig["unknown"][number]): string => (u.nearest === null ? "" : ` (did you mean ${u.nearest}?)`);
  if (config.unknown.length === 0) return null;
  if (config.unknown.length === 1) return `unknown key ${config.unknown[0]!.key} in ${config.path}${hint(config.unknown[0]!)}`;
  return `unknown keys ${config.unknown.map((u) => `${u.key}${hint(u)}`).join(", ")} in ${config.path}`;
}

// The line a command prints once for unknown keys.
export function unknownKeysWarning(config: UserConfig): string | null {
  const line = unknownKeys(config);
  return line === null ? null : `${line}: ignored, and automatic updates are paused until it is fixed`;
}

// Makes the document a mapping, so keys can be set: a file of comments
// only, or `---` with nothing after it, keeps its comments.
export function asMapping(doc: Document): void {
  if (doc.contents === null) {
    doc.contents = doc.createNode({});
    return;
  }
  if (isScalar(doc.contents) && (doc.contents.value === null || doc.contents.value === undefined)) {
    const { commentBefore, comment } = doc.contents;
    doc.contents = doc.createNode({});
    doc.commentBefore = [doc.commentBefore, commentBefore, comment].filter((c) => c).join("\n") || null;
  }
}
