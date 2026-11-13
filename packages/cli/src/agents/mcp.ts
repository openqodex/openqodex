// The code graph's MCP server, named openqodex, registered with each agent
// by `init`: an entry under `mcpServers` of a JSON file (Claude Code, Cursor,
// Cline), or a marked block at the end of Codex's config.toml. The files,
// the shapes and their sources are in templates/README.md. As everywhere in
// init, a registration is changed or removed only while it is still exactly
// what the record says init wrote.
import { readText } from "./files.js";
import type { Action, Ctx } from "./plan.js";
import { canonical, type InstallRecord, type McpRecord } from "./record.js";
import type { Target } from "./targets.js";
import { readTomlKeys } from "./toml-keys.js";

export const MCP_SERVER = "openqodex";
export const TOML_START = "# openqodex:start";
export const TOML_END = "# openqodex:end";

type JsonTarget = Extract<Target, { kind: "mcp-json" }>;
type TomlTarget = Extract<Target, { kind: "mcp-toml" }>;
type JsonRecord = Extract<McpRecord, { kind: "json" }>;
type TomlRecord = Extract<McpRecord, { kind: "toml" }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// A file init creates is private in user scope and readable in a repository.
function modeFor(t: Target): number {
  return t.inRepo ? 0o644 : 0o600;
}

function recordOf(record: InstallRecord, path: string): McpRecord | undefined {
  return record.mcp.find((m) => m.path === path);
}

function remember(record: InstallRecord, entry: McpRecord): void {
  record.mcp = record.mcp.filter((m) => m.path !== entry.path);
  record.mcp.push(entry);
}

function forget(record: InstallRecord, path: string): void {
  record.mcp = record.mcp.filter((m) => m.path !== path);
}

// ---- JSON files: Claude Code, Cursor, Cline ----

type McpFile = { data: Record<string, unknown>; servers: Record<string, unknown> | undefined };

// The file as an object whose mcpServers, when present, is an object; the
// reason when it must be left alone. An absent file is an empty object.
export function parseMcpFile(text: string | null): McpFile | string {
  if (text === null) return { data: {}, servers: undefined };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return "does not parse as JSON";
  }
  if (!isObject(data)) return "is not a JSON object";
  if (data.mcpServers !== undefined && !isObject(data.mcpServers)) return '"mcpServers" is not an object';
  return { data, servers: data.mcpServers as Record<string, unknown> | undefined };
}

// The value under mcpServers.openqodex, as a comparable key; undefined when
// there is none.
function serverKey(file: McpFile): string | undefined {
  const servers = file.servers;
  return servers !== undefined && Object.hasOwn(servers, MCP_SERVER) ? canonical(servers[MCP_SERVER]) : undefined;
}

// Re-reads the file when the action runs. Claude Code rewrites ~/.claude.json
// on its own while it runs (counters, tips, project history), so the byte
// check every other action makes between the plan and the write would refuse
// often for a change that is not ours to judge. The action applies its change
// to what is there now instead, and refuses only when the openqodex entry
// itself changed since the plan, the one thing the plan decided from.
// `absent`: there is no file now.
function reread(t: JsonTarget, planned: string | undefined): { now: McpFile; absent: boolean } {
  const text = readText(t.path);
  const now = parseMcpFile(text);
  if (typeof now === "string") throw new Error(`changed while init was running: the file ${now}; nothing written`);
  if (serverKey(now) !== planned) throw new Error(`changed while init was running: the ${MCP_SERVER} server in it is not what the plan saw; nothing written`);
  return { now, absent: text === null };
}

export function planJsonInstall(t: JsonTarget, ctx: Ctx, before: string | null): Action {
  const { record } = ctx;
  const base = { path: t.path, agent: t.agent };
  const parsed = parseMcpFile(before);
  if (typeof parsed === "string") return { ...base, verb: "refuse", failed: true, note: `${t.label}: the file ${parsed}; left untouched, fix it and run init again` };
  const rec = recordOf(record, t.path);
  const recorded = rec?.kind === "json" ? rec : undefined;
  const ours = canonical(t.entry);
  const there = serverKey(parsed);
  const entry = (createdFile: boolean, createdKey: boolean): JsonRecord => ({ kind: "json", path: t.path, entry: t.entry, createdFile, createdKey, usesLauncher: t.usesLauncher });
  if (there === ours) {
    // Exactly what we would write: ours, recorded or not.
    if (recorded === undefined || canonical(recorded.entry) !== ours) remember(record, entry(recorded?.createdFile ?? false, recorded?.createdKey ?? false));
    return { ...base, verb: "skip", note: `${t.label} already present` };
  }
  if (there !== undefined && (recorded === undefined || canonical(recorded.entry) !== there)) {
    return {
      ...base,
      verb: "keep",
      note: recorded ? `${t.label} was edited after install; left as it is` : `${t.label}: a server named ${MCP_SERVER} that init did not write is there; left alone`,
    };
  }
  const verb = before === null ? "create" : there !== undefined ? "update" : "merge";
  const note =
    verb === "update" ? `${t.label}, replacing the one an earlier openqodex wrote` : verb === "merge" ? `${t.label}, other servers and settings kept` : t.label;
  // No guard field: reread() does the guard's work at write time.
  return {
    ...base,
    verb,
    note: t.hint ? `${note}; ${t.hint}` : note,
    apply: () => {
      const { now, absent } = reread(t, there);
      const createdKey = now.servers === undefined;
      now.data.mcpServers = { ...now.servers, [MCP_SERVER]: t.entry };
      ctx.guard.write(t.path, json(now.data), { mode: modeFor(t), keepMode: true });
      // An update keeps what the earlier init created.
      remember(record, entry(recorded?.createdFile ?? absent, recorded?.createdKey ?? createdKey));
    },
  };
}

// `recordedOnly`: remove only what the record names (--no-mcp). Without it,
// a project-scope removal with no record (a teammate's machine) counts an
// entry equal to the current one as ours, as every project target does.
export function planJsonRemoval(t: JsonTarget, ctx: Ctx, before: string | null, recordedOnly: boolean): Action | null {
  const { record } = ctx;
  const base = { path: t.path, agent: t.agent };
  const rec = recordOf(record, t.path);
  const recorded = rec?.kind === "json" ? rec : undefined;
  if (before === null) {
    forget(record, t.path);
    return null;
  }
  const teammate = recorded === undefined && ctx.scope === "project" && !recordedOnly;
  const parsed = parseMcpFile(before);
  if (typeof parsed === "string") {
    return recorded || teammate ? { ...base, verb: "refuse", failed: true, note: `${t.label}: the file ${parsed}; left untouched` } : null;
  }
  const there = serverKey(parsed);
  const expected = recorded ? canonical(recorded.entry) : teammate ? canonical(t.entry) : undefined;
  if (there === undefined || expected === undefined || there !== expected) {
    forget(record, t.path);
    return recorded && there !== undefined ? { ...base, verb: "keep", note: `${t.label} was edited after install; left in place` } : null;
  }
  const createdKey = recorded ? recorded.createdKey : true;
  const createdFile = recorded ? recorded.createdFile : true;
  // What is left once our entry goes, as the plan sees it.
  const left = (file: McpFile): Record<string, unknown> => {
    const servers = { ...file.servers };
    delete servers[MCP_SERVER];
    const data: Record<string, unknown> = { ...file.data, mcpServers: servers };
    if (createdKey && Object.keys(servers).length === 0) delete data.mcpServers;
    return data;
  };
  const removesFile = createdFile && Object.keys(left(parsed)).length === 0;
  return {
    ...base,
    verb: removesFile ? "remove" : "update",
    note: removesFile ? `${t.label} (init created this file)` : `${t.label} removed, other servers and settings kept`,
    apply: () => {
      const now = left(reread(t, there).now);
      if (createdFile && Object.keys(now).length === 0) ctx.guard.remove(t.path);
      else ctx.guard.write(t.path, json(now), { keepMode: true });
      forget(record, t.path);
    },
  };
}

// ---- Codex's config.toml ----

// A TOML basic string: backslash, double quote and every control character
// escaped (TOML 1.0, "String": U+0000 to U+001F and U+007F must be).
export function tomlString(value: string): string {
  const named: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (named[ch] !== undefined) out += named[ch];
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

// The block init appends to Codex's config.toml, markers included, with no
// final newline.
export function tomlBlock(command: string, args: string[]): string {
  return [TOML_START, `[mcp_servers.${MCP_SERVER}]`, `command = ${tomlString(command)}`, `args = [${args.map(tomlString).join(", ")}]`, TOML_END].join("\n");
}

// Where our block sits: from a line that is exactly the start marker to the
// next line that is exactly the end marker.
function blockBounds(text: string): { start: number; end: number } | null {
  const m = new RegExp(`(^|\\n)(${TOML_START}\\n[\\s\\S]*?\\n${TOML_END})(?=\\n|$)`).exec(text);
  if (m === null) return null;
  const start = m.index + m[1].length;
  return { start, end: start + m[2].length };
}

// Why the text outside our block rules out adding it, or null. A second
// definition of the server makes Codex refuse the whole file, so the file's
// key paths are read as TOML reads them (toml-keys.ts), quoted and escaped
// keys decoded and strings stepped over: a path equal to or under
// mcp_servers.openqodex is a definition, whether a table, an array of
// tables, a dotted key or an inline table. mcp_servers set to anything but
// a table rules it out too: no [mcp_servers.openqodex] table can add to an
// inline table, and on a value or an array of tables it means something
// else. A file the reader cannot read is left alone.
export function tomlConflict(text: string): string | null {
  const read = readTomlKeys(text);
  if (!read.ok) return `the file could not be read as TOML (${read.reason})`;
  for (const { path, kind } of read.keys) {
    if (path[0] !== "mcp_servers") continue;
    if (path[1] === MCP_SERVER) return `the file already defines a server named ${MCP_SERVER}, and a second one would make Codex refuse the whole file`;
    if (path.length === 1 && kind === "inline-table") return "the file sets mcp_servers as an inline table, which a [mcp_servers.openqodex] table cannot add to";
    if (path.length === 1 && kind !== "table") return "the file sets mcp_servers to something other than a table";
  }
  return null;
}

export function planTomlInstall(t: TomlTarget, ctx: Ctx, before: string | null): Action {
  const { record } = ctx;
  const base = { path: t.path, agent: t.agent, guard: { path: t.path, before } };
  const rec = recordOf(record, t.path);
  const recorded = rec?.kind === "toml" ? rec : undefined;
  const entry = (createdFile: boolean, newline: boolean): TomlRecord => ({ kind: "toml", path: t.path, block: t.block, createdFile, newline, usesLauncher: t.usesLauncher });
  const withHint = (note: string): string => (t.hint ? `${note}; ${t.hint}` : note);
  if (before === null) {
    return {
      ...base,
      verb: "create",
      note: withHint(t.label),
      apply: () => {
        ctx.guard.write(t.path, `${t.block}\n`, { mode: modeFor(t), keepMode: true });
        remember(record, entry(true, false));
      },
    };
  }
  const at = blockBounds(before);
  const existing = at === null ? null : before.slice(at.start, at.end);
  if (existing === t.block) {
    if (recorded === undefined || recorded.block !== t.block) remember(record, entry(recorded?.createdFile ?? false, recorded?.newline ?? false));
    return { ...base, verb: "skip", note: `${t.label} already present` };
  }
  if (existing !== null && recorded?.block !== existing) return { ...base, verb: "keep", note: `${t.label} was edited; left as it is` };
  const outside = at === null ? before : before.slice(0, at.start) + before.slice(at.end);
  const conflict = tomlConflict(outside);
  if (conflict !== null) return { ...base, verb: "keep", note: `${t.label}: ${conflict}; left alone` };
  if (at !== null && recorded !== undefined) {
    const replaced = before.slice(0, at.start) + t.block + before.slice(at.end);
    return {
      ...base,
      verb: "update",
      note: withHint(`${t.label}, replacing the one an earlier openqodex wrote`),
      apply: () => {
        ctx.guard.write(t.path, replaced, { keepMode: true });
        remember(record, entry(recorded.createdFile, recorded.newline));
      },
    };
  }
  const newline = before !== "" && !before.endsWith("\n");
  return {
    ...base,
    verb: "append",
    note: withHint(`${t.label}, at the end of the file`),
    apply: () => {
      ctx.guard.write(t.path, `${before}${newline ? "\n" : ""}${t.block}\n`, { keepMode: true });
      remember(record, entry(false, newline));
    },
  };
}

// Why removing the block would change a key that is not ours, or null. The
// table the block opens, [mcp_servers.openqodex], runs on to the next
// header, so a key the developer wrote after the end marker is in it, and
// once the block goes it would sit under the table before the block. The
// file must define no key under mcp_servers.openqodex that the block does
// not; a file the reader cannot read is not judged.
function tomlTableOutside(text: string, block: string): string | null {
  const count = (t: string): number | null => {
    const read = readTomlKeys(t);
    return read.ok ? read.keys.filter((k) => k.path[0] === "mcp_servers" && k.path[1] === MCP_SERVER).length : null;
  };
  const all = count(text);
  if (all === null) return "the file could not be read as TOML, so what belongs to the block's table cannot be told";
  return all > (count(block) ?? 0) ? `a key after the block belongs to its [mcp_servers.${MCP_SERVER}] table, and would move to the table before the block if the block went` : null;
}

export function planTomlRemoval(t: TomlTarget, ctx: Ctx, before: string | null, recordedOnly: boolean): Action | null {
  const { record } = ctx;
  const base = { path: t.path, agent: t.agent, guard: { path: t.path, before } };
  const rec = recordOf(record, t.path);
  const recorded = rec?.kind === "toml" ? rec : undefined;
  const at = before === null ? null : blockBounds(before);
  if (before === null || at === null) {
    forget(record, t.path);
    return null;
  }
  const existing = before.slice(at.start, at.end);
  const teammate = recorded === undefined && ctx.scope === "project" && !recordedOnly;
  const ours = recorded ? existing === recorded.block : teammate && existing === t.block;
  if (!ours) {
    forget(record, t.path);
    return recorded ? { ...base, verb: "keep", note: `${t.label} was edited; left in place` } : null;
  }
  const outside = tomlTableOutside(before, existing);
  if (outside !== null) {
    forget(record, t.path);
    return { ...base, verb: "keep", note: `${t.label}: ${outside}; left in place` };
  }
  let head = before.slice(0, at.start);
  let tail = before.slice(at.end);
  if (tail.startsWith("\n")) tail = tail.slice(1);
  // The newline init added before the block, when nothing came after it.
  if (recorded?.newline && tail === "" && head.endsWith("\n")) head = head.slice(0, -1);
  const rest = head + tail;
  const created = recorded ? recorded.createdFile : true;
  if (rest.trim() === "" && created) {
    return {
      ...base,
      verb: "remove",
      note: `${t.label} (only our block was in it)`,
      apply: () => {
        ctx.guard.remove(t.path);
        forget(record, t.path);
      },
    };
  }
  return {
    ...base,
    verb: "update",
    note: `${t.label} removed, the rest of the file kept`,
    apply: () => {
      ctx.guard.write(t.path, rest, { keepMode: true });
      forget(record, t.path);
    },
  };
}
