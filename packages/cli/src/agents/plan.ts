// Turns targets into actions, each saying what it will do, so `init` prints
// the full plan before it writes anything. Ownership comes from the
// installation record: a thing is changed or removed only while it is still
// exactly what we wrote. In project scope a machine with no record (a
// teammate's) counts a thing as ours only when it equals the current output.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { AgentId } from "./detect.js";
import { readText, sha256 } from "./files.js";
import type { Guard } from "./guarded-fs.js";
import { MCP_SERVER, planJsonInstall, planJsonRemoval, planTomlInstall, planTomlRemoval, TOML_START } from "./mcp.js";
import { canonical, type InstallRecord } from "./record.js";
import type { Scope, Target } from "./targets.js";
import { isShippedSkill, sameSection, SECTION_END, SECTION_START, TEAM_OPENINGS } from "./targets.js";

export type Verb = "create" | "update" | "merge" | "append" | "replace" | "remove" | "restore" | "skip" | "keep" | "refuse";

export type Action = {
  verb: Verb;
  path: string;
  note: string;
  agent?: AgentId;
  // Set when the thing could not be handled; init exits 2 after the rest.
  failed?: boolean;
  // The bytes the plan was built from; the write is refused if they changed.
  guard?: { path: string; before: string | null };
  // Absent for skip, keep and refuse.
  apply?: () => void | Promise<void>;
};

// `guard`: the one way this run writes, renames and deletes (guarded-fs.ts).
export type Ctx = { record: InstallRecord; scope: Scope; repoRoot: string | null; guard: Guard };

type Settings = {
  hooks?: { PreToolUse?: unknown[]; [k: string]: unknown };
  permissions?: { allow?: unknown[]; [k: string]: unknown };
  [k: string]: unknown;
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parses a settings file and checks the parts we touch have the shape the
// agent expects. Returns the reason when the file must be left alone.
function parseSettings(text: string): Settings | string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return "does not parse as JSON";
  }
  if (!isObject(data)) return "is not a JSON object";
  if (data.permissions !== undefined) {
    if (!isObject(data.permissions)) return '"permissions" is not an object';
    if (data.permissions.allow !== undefined && !Array.isArray(data.permissions.allow)) return '"permissions.allow" is not a list';
  }
  if (data.hooks !== undefined) {
    if (!isObject(data.hooks)) return '"hooks" is not an object';
    const pre = data.hooks.PreToolUse;
    if (pre !== undefined && !Array.isArray(pre)) return '"hooks.PreToolUse" is not a list';
  }
  return data as Settings;
}

function commandsOf(group: unknown): string[] {
  if (!isObject(group) || !Array.isArray(group.hooks)) return [];
  return group.hooks.filter(isObject).map((h) => h.command).filter((c): c is string => typeof c === "string");
}

// Removes the groups equal to any of `entries`; drops lists and objects left
// empty by it. Returns how many were removed.
function removeGroups(data: Settings, entries: unknown[]): number {
  const pre = data.hooks?.PreToolUse;
  if (!pre) return 0;
  const keys = new Set(entries.map(canonical));
  const kept = pre.filter((g) => !keys.has(canonical(g)));
  const removed = pre.length - kept.length;
  if (removed === 0) return 0;
  if (kept.length > 0) data.hooks!.PreToolUse = kept;
  else delete data.hooks!.PreToolUse;
  if (Object.keys(data.hooks!).length === 0) delete data.hooks;
  return removed;
}

// Removes one entry of each rule from permissions.allow; drops the list and
// the object when left empty.
function removeAllow(data: Settings, rules: string[]): void {
  const allow = data.permissions?.allow;
  if (!allow) return;
  const left = [...allow];
  for (const rule of rules) {
    const i = left.indexOf(rule);
    if (i !== -1) left.splice(i, 1);
  }
  if (left.length > 0) data.permissions!.allow = left;
  else delete data.permissions!.allow;
  if (Object.keys(data.permissions!).length === 0) delete data.permissions;
}

// The permission rules init added to this settings file. Only user scope
// has them, so the record always knows them.
function ourRules(ctx: Ctx, path: string): string[] {
  return ctx.record.allowRules.filter((r) => r.path === path).map((r) => r.rule);
}

// What this process wrote to each settings file. The hook and the permission
// rules share settings.json: the rules' action, applied right after the hook's,
// accepts the file as the plan saw it or as the hook's action left it, and
// refuses anything else, as every other action's guard does.
const writtenThisRun = new Map<string, string | null>();

// A file the developer owns keeps its own mode; a new one gets `mode`.
function writeSettings(g: Guard, path: string, text: string, mode?: number): void {
  g.write(path, text, { mode, keepMode: true });
  writtenThisRun.set(path, text);
}

function removeSettings(g: Guard, path: string): void {
  removeFile(g, path);
  writtenThisRun.set(path, null);
}

function unchangedSincePlan(path: string, before: string | null): string | null {
  const now = readText(path);
  if (now !== before && !(writtenThisRun.has(path) && writtenThisRun.get(path) === now)) {
    throw new Error(`changed while init was running, nothing written to ${path}`);
  }
  return now;
}

// Removes the file (a link as itself), then its folder when the folder is
// named openqodex and is left empty (the skill folder).
function removeFile(g: Guard, path: string): void {
  g.remove(path);
  if (basename(dirname(path)) === "openqodex") g.removeEmptyFolder(dirname(path));
}

function sectionBounds(text: string): { start: number; end: number } | null {
  const start = text.indexOf(SECTION_START);
  if (start === -1) return null;
  const endAt = text.indexOf(SECTION_END, start);
  if (endAt === -1) return null;
  return { start, end: endAt + SECTION_END.length };
}

function setFile(record: InstallRecord, path: string, content: string, usesLauncher = false): void {
  record.files = record.files.filter((f) => f.path !== path);
  record.files.push({ path, sha256: sha256(content), usesLauncher });
}

function dropFile(record: InstallRecord, path: string): void {
  record.files = record.files.filter((f) => f.path !== path);
}

// The recorded file entry when the file on disk is still what we wrote.
export function ownedFile(record: InstallRecord, path: string, text: string | null): boolean {
  const rec = record.files.find((f) => f.path === path);
  return rec !== undefined && text !== null && sha256(text) === rec.sha256;
}

// Every target, whatever its scope, is refused when its path runs through a
// link the repository holds or lands outside every folder init writes
// (guarded-fs.ts); every write checks again when it lands.
function checkRepoPath(t: Target, ctx: Ctx): void {
  ctx.guard.check(t.path);
}

// A markdown file, in the repository or not, goes through the guard like
// every other file.
function writeMarkdown(t: Target, ctx: Ctx, content: string): void {
  ctx.guard.write(t.path, content, { keepMode: true });
}

function removeMarkdown(t: Target, ctx: Ctx): void {
  removeFile(ctx.guard, t.path);
}

export function planInstall(t: Target, ctx: Ctx): Action {
  const { record } = ctx;
  checkRepoPath(t, ctx);
  const before = readText(t.path);
  const base = { path: t.path, agent: t.agent, guard: { path: t.path, before } };
  switch (t.kind) {
    case "file": {
      const write = (): void => {
        ctx.guard.write(t.path, t.content, { keepMode: true });
        setFile(record, t.path, t.content, t.usesLauncher);
      };
      if (before === null) return { ...base, verb: "create", note: t.label, apply: write };
      if (before === t.content) return { ...base, verb: "skip", note: `${t.label} already present` };
      if (ownedFile(record, t.path, before)) return { ...base, verb: "update", note: t.label, apply: write };
      // A skill as some version shipped it (npx skills add copies it as it
      // is) is ours: left in place it would never update. An edited one is not.
      if (t.skillRunner !== undefined && isShippedSkill(before, t.skillRunner)) {
        return { ...base, verb: "replace", note: `${t.label}, in place of a copy of the shipped skill, which never updates`, apply: write };
      }
      const recorded = record.files.some((f) => f.path === t.path);
      return {
        ...base,
        verb: "keep",
        note: recorded ? `${t.label} was edited after install; left as it is` : `${t.label}: a file with other content is there; left alone`,
      };
    }
    case "hook-json": {
      const recs = record.hooks.filter((h) => h.path === t.path);
      const entry = { path: t.path, entry: t.group, usesLauncher: t.usesLauncher };
      if (before === null) {
        return {
          ...base,
          verb: "create",
          note: t.label,
          apply: () => {
            writeSettings(ctx.guard, t.path, json({ hooks: { PreToolUse: [t.group] } }), t.inRepo ? 0o644 : 0o600);
            record.hooks.push({ ...entry, createdFile: true });
          },
        };
      }
      const data = parseSettings(before);
      if (typeof data === "string") {
        return { ...base, verb: "refuse", failed: true, note: `${t.label}: the file ${data}; left untouched, fix it and run init again` };
      }
      const groups = data.hooks?.PreToolUse ?? [];
      const current = canonical(t.group);
      if (groups.some((g) => canonical(g) === current)) {
        // Exactly what we would write: ours, recorded or not.
        if (!recs.some((r) => canonical(r.entry) === current)) record.hooks.push({ ...entry, createdFile: false });
        return { ...base, verb: "skip", note: `${t.label} already present` };
      }
      const oldIndex = groups.findIndex((g) => recs.some((r) => canonical(r.entry) === canonical(g)));
      if (oldIndex !== -1) {
        const old = recs.find((r) => canonical(r.entry) === canonical(groups[oldIndex]))!;
        groups[oldIndex] = t.group;
        return {
          ...base,
          verb: "update",
          note: `${t.label}, replacing the one an earlier openqodex wrote`,
          apply: () => {
            writeSettings(ctx.guard, t.path, json(data));
            record.hooks = record.hooks.filter((r) => r !== old);
            record.hooks.push({ ...entry, createdFile: old.createdFile });
          },
        };
      }
      const ourCommands = new Set([...commandsOf(t.group), ...recs.flatMap((r) => commandsOf(r.entry))]);
      if (groups.some((g) => commandsOf(g).some((c) => ourCommands.has(c)))) {
        return { ...base, verb: "keep", note: `${t.label} was edited after install; left as it is` };
      }
      data.hooks ??= {};
      data.hooks.PreToolUse = [...groups, t.group];
      const hasBackup = record.backups.some((b) => b.of === t.path);
      return {
        ...base,
        verb: "merge",
        note: `${t.label}, other settings kept${hasBackup ? "" : ` (the file as it was is saved beside it as ${basename(t.path)}.openqodex.bak)`}`,
        apply: () => {
          if (!hasBackup) record.backups.push({ path: ctx.guard.backup(t.path, before), of: t.path });
          writeSettings(ctx.guard, t.path, json(data));
          record.hooks.push({ ...entry, createdFile: false });
        },
      };
    }
    case "allow-rules": {
      const data = before === null ? {} : parseSettings(before);
      if (typeof data === "string") return { ...base, verb: "refuse", failed: true, note: `${t.label}: the file ${data}; left untouched` };
      const have = (data.permissions?.allow ?? []) as unknown[];
      const wanted = t.rules;
      // Rules an earlier version granted and this one does not: removed while
      // still there as recorded. A rule the record does not name is never touched.
      const recorded = ourRules(ctx, t.path);
      const stale = recorded.filter((r) => !wanted.includes(r));
      const staleThere = stale.filter((r) => have.includes(r));
      const missing = wanted.filter((r) => !have.includes(r));
      const forgetStale = (gone: string[]): void => {
        record.allowRules = record.allowRules.filter((r) => r.path !== t.path || !gone.includes(r.rule));
      };
      if (missing.length === 0 && staleThere.length === 0) {
        forgetStale(stale);
        return { ...base, verb: "skip", note: t.rules.length > 0 ? `${t.label} already present` : `${t.label}: none in project scope` };
      }
      const parts = [
        ...(missing.length > 0 ? [`Claude Code runs these review commands without asking: ${missing.join(", ")}`] : []),
        ...(staleThere.length > 0 ? [`no longer allowed: ${staleThere.join(", ")}`] : []),
      ];
      // No guard field: the hook's action writes the same file just before.
      // unchangedSincePlan does the guard's work at write time.
      return {
        path: t.path,
        agent: t.agent,
        verb: recorded.length > 0 ? "update" : "merge",
        note: `${t.label}: ${parts.join("; ")}`,
        apply: () => {
          const text = unchangedSincePlan(t.path, before);
          const now = text === null ? {} : parseSettings(text);
          if (typeof now === "string") throw new Error(`the file ${now}`);
          const goneNow = recorded.filter((r) => !wanted.includes(r));
          removeAllow(now, goneNow.filter((r) => ((now.permissions?.allow ?? []) as unknown[]).includes(r)));
          const allow = (now.permissions?.allow ?? []) as unknown[];
          const add = wanted.filter((r) => !allow.includes(r));
          if (add.length > 0) now.permissions = { ...now.permissions, allow: [...allow, ...add] };
          writeSettings(ctx.guard, t.path, json(now), t.inRepo ? 0o644 : 0o600);
          forgetStale(goneNow);
          for (const rule of add) record.allowRules.push({ path: t.path, rule });
        },
      };
    }
    case "md-section": {
      const rec = record.sections.find((s) => s.path === t.path);
      const section = t.section;
      const remember = (createdFile: boolean): void => {
        record.sections = record.sections.filter((s) => s.path !== t.path);
        record.sections.push({ path: t.path, text: section, createdFile });
      };
      if (before === null) {
        return {
          ...base,
          verb: "create",
          note: t.label,
          apply: () => {
            writeMarkdown(t, ctx, `${section}\n`);
            remember(true);
          },
        };
      }
      const at = sectionBounds(before);
      if (at === null) {
        const joined = before === "" ? `${section}\n` : `${before}${before.endsWith("\n") ? "\n" : "\n\n"}${section}\n`;
        return {
          ...base,
          verb: "append",
          note: `${t.label} section`,
          apply: () => {
            writeMarkdown(t, ctx, joined);
            remember(false);
          },
        };
      }
      const existing = before.slice(at.start, at.end);
      if (existing === section) {
        if (!rec) remember(false);
        return { ...base, verb: "skip", note: `${t.label} section already present` };
      }
      if ((rec && existing === rec.text) || t.replaces?.some((r) => sameSection(existing, r))) {
        const replaced = before.slice(0, at.start) + section + before.slice(at.end);
        return {
          ...base,
          verb: "replace",
          note: `${t.label} section`,
          apply: () => {
            writeMarkdown(t, ctx, replaced);
            remember(rec?.createdFile ?? false);
          },
        };
      }
      return { ...base, verb: "keep", note: `${t.label} section was edited; left as it is` };
    }
    case "mcp-json":
      return planJsonInstall(t, ctx, before);
    case "mcp-toml":
      return planTomlInstall(t, ctx, before);
  }
}

// The text of the regular file at `path`, opened without blocking (a named
// pipe cannot hold the open) and without following a link: null when it is
// missing, "other" when it is not a regular file or cannot be read.
function readPlain(path: string): string | null | "other" {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "other";
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd, "utf8") : "other";
  } catch {
    return "other";
  } finally {
    closeSync(fd);
  }
}

// Whether OpenQodex's part of `t` is on disk, as any version wrote it and
// whether or not a record names it: the file, a marked section other than
// the team section, a hook group whose command runs openqodex, the openqodex
// MCP server entry or block.
// Uninstall asks it of an agent that stays (init.ts). A file it cannot read
// or parse, a link or anything but a regular file counts as there, so a
// doubt keeps a shared file.
export function setUpAt(t: Target): boolean {
  if (t.kind === "allow-rules") return false;
  if (t.kind === "file") {
    try {
      lstatSync(t.path);
      return true;
    } catch {
      return false;
    }
  }
  const text = readPlain(t.path);
  if (text === "other") return true;
  if (text === null) return false;
  switch (t.kind) {
    case "md-section": {
      // The team section shares the markers but is the team's, never an agent's.
      const at = text.indexOf(SECTION_START);
      const inside = at === -1 ? "" : text.slice(at + SECTION_START.length).replace(/^\r?\n/, "");
      return at !== -1 && !TEAM_OPENINGS.some((o) => inside.startsWith(o));
    }
    case "mcp-toml":
      return text.includes(TOML_START);
    case "hook-json": {
      const data = parseSettings(text);
      return typeof data === "string" || (data.hooks?.PreToolUse ?? []).some((g) => commandsOf(g).some((c) => c.includes("openqodex")));
    }
    case "mcp-json": {
      try {
        const data: unknown = JSON.parse(text);
        return !isObject(data) || (isObject(data.mcpServers) && data.mcpServers[MCP_SERVER] !== undefined);
      } catch {
        return true;
      }
    }
  }
}

// Null when there is nothing of ours there.
export function planUninstall(t: Target, ctx: Ctx): Action | null {
  const { record, scope } = ctx;
  checkRepoPath(t, ctx);
  const before = readText(t.path);
  const base = { path: t.path, agent: t.agent, guard: { path: t.path, before } };
  switch (t.kind) {
    case "file": {
      const recorded = record.files.some((f) => f.path === t.path);
      const ours = recorded ? ownedFile(record, t.path, before) : scope === "project" && before === t.content;
      if (before === null || (!ours && !recorded)) {
        dropFile(record, t.path);
        return null;
      }
      if (!ours) {
        dropFile(record, t.path);
        return { ...base, verb: "keep", note: `${t.label} was edited after install; left in place` };
      }
      return {
        ...base,
        verb: "remove",
        note: t.label,
        apply: () => {
          removeFile(ctx.guard, t.path);
          dropFile(record, t.path);
        },
      };
    }
    case "hook-json": {
      const recs = record.hooks.filter((h) => h.path === t.path);
      const forget = (): void => {
        record.hooks = record.hooks.filter((h) => h.path !== t.path);
      };
      if (before === null) {
        forget();
        return null;
      }
      const data = parseSettings(before);
      if (typeof data === "string") {
        return recs.length > 0 || scope === "project"
          ? { ...base, verb: "refuse", failed: true, note: `${t.label}: the file ${data}; left untouched` }
          : null;
      }
      const candidates = [...recs.map((r) => r.entry), ...(recs.length === 0 && scope === "project" ? [t.group] : [])];
      // Our permission rules in the same file go too, so the file can match
      // its copy from before install.
      removeAllow(data, ourRules(ctx, t.path));
      if (removeGroups(data, candidates) === 0) {
        forget();
        return recs.length > 0 ? { ...base, verb: "keep", note: `${t.label} was edited after install; left in place` } : null;
      }
      const backup = record.backups.find((b) => b.of === t.path);
      const backupText = backup ? readText(backup.path) : null;
      const backupData = backupText === null ? null : parseSettings(backupText);
      const dropBackup = (): void => {
        record.backups = record.backups.filter((b) => b !== backup);
      };
      if (backup && backupText !== null && typeof backupData !== "string" && canonical(backupData) === canonical(data)) {
        return {
          ...base,
          verb: "restore",
          note: `${t.label} removed; the file is back as it was before install`,
          apply: () => {
            writeSettings(ctx.guard, t.path, backupText);
            ctx.guard.remove(backup.path);
            dropBackup();
            forget();
          },
        };
      }
      const created = recs.length > 0 ? recs.some((r) => r.createdFile) : scope === "project";
      if (created && Object.keys(data).length === 0) {
        return {
          ...base,
          verb: "remove",
          note: `${t.label} (init created this file)`,
          apply: () => {
            removeSettings(ctx.guard, t.path);
            forget();
          },
        };
      }
      return {
        ...base,
        verb: "update",
        note: `${t.label} removed, other settings kept${backup ? ` (the copy from before install stays at ${backup.path})` : ""}`,
        apply: () => {
          writeSettings(ctx.guard, t.path, json(data));
          dropBackup();
          forget();
        },
      };
    }
    case "allow-rules": {
      const rules = ourRules(ctx, t.path);
      const forget = (): void => {
        record.allowRules = record.allowRules.filter((r) => r.path !== t.path);
      };
      if (rules.length === 0 || before === null) {
        forget();
        return null;
      }
      const data = parseSettings(before);
      if (typeof data === "string") return { ...base, verb: "refuse", failed: true, note: `${t.label}: the file ${data}; left untouched` };
      if (!rules.some((r) => (data.permissions?.allow ?? []).includes(r))) {
        forget();
        return null;
      }
      const created = record.hooks.some((h) => h.path === t.path && h.createdFile);
      return {
        path: t.path,
        agent: t.agent,
        verb: "update",
        note: `${t.label} removed: ${rules.join(", ")}`,
        apply: () => {
          const text = unchangedSincePlan(t.path, before);
          const now = text === null ? null : parseSettings(text);
          if (typeof now === "string") throw new Error(`the file ${now}`);
          // The hook's removal may already have taken the rules out, or put
          // the file back as it was: then there is nothing to write.
          if (now !== null && rules.some((r) => (now.permissions?.allow ?? []).includes(r))) {
            removeAllow(now, rules);
            if (created && Object.keys(now).length === 0) removeSettings(ctx.guard, t.path);
            else writeSettings(ctx.guard, t.path, json(now));
          }
          forget();
        },
      };
    }
    case "md-section": {
      const rec = record.sections.find((s) => s.path === t.path);
      const forget = (): void => {
        record.sections = record.sections.filter((s) => s.path !== t.path);
      };
      const at = before === null ? null : sectionBounds(before);
      if (before === null || at === null) {
        forget();
        return null;
      }
      const existing = before.slice(at.start, at.end);
      const ours = rec ? existing === rec.text : scope === "project" && existing === t.section;
      if (!ours) {
        forget();
        return rec ? { ...base, verb: "keep", note: `${t.label} section was edited; left in place` } : null;
      }
      let head = before.slice(0, at.start);
      let tail = before.slice(at.end);
      if (tail.startsWith("\n")) tail = tail.slice(1);
      if (tail === "" && head.endsWith("\n\n")) head = head.slice(0, -1);
      const rest = head + tail;
      const created = rec ? rec.createdFile : true;
      if (rest.trim() === "" && created) {
        return {
          ...base,
          verb: "remove",
          note: `${t.label} (only our section was in it)`,
          apply: () => {
            removeMarkdown(t, ctx);
            forget();
          },
        };
      }
      return {
        ...base,
        verb: "update",
        note: `${t.label} section removed`,
        apply: () => {
          writeMarkdown(t, ctx, rest);
          forget();
        },
      };
    }
    case "mcp-json":
      return planJsonRemoval(t, ctx, before, false);
    case "mcp-toml":
      return planTomlRemoval(t, ctx, before, false);
  }
}

// --no-mcp: removes the code graph's MCP server where the record says init
// added it, and nothing a record does not name, in either scope. Null when
// there is nothing of ours there.
export function planMcpOff(t: Extract<Target, { kind: "mcp-json" | "mcp-toml" }>, ctx: Ctx): Action | null {
  checkRepoPath(t, ctx);
  const before = readText(t.path);
  return t.kind === "mcp-json" ? planJsonRemoval(t, ctx, before, true) : planTomlRemoval(t, ctx, before, true);
}

