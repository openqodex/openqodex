// Where Claude Code and Codex keep their own files, as each agent reads it:
// Claude Code from CLAUDE_CONFIG_DIR, Codex from CODEX_HOME, else a folder in
// the home folder. Detection and every user-scope target init writes there
// use these two functions, so an install never puts part of itself in a
// folder the agent does not read. Codex's skills are not here: its docs name
// ~/.agents/skills, apart from its config folder.
//
// The value is kept as spelled, `.` and `..` included, and never folded by
// hand: the system resolves `..` after the links before it, and so does the
// check every write passes (real-path.ts). Folding it here would point init
// at another folder than the agent reads.
import { join, sep } from "node:path";

function fromEnv(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  const trimmed = value.length > 1 ? value.replace(/[\\/]+$/, "") : value;
  return trimmed.startsWith(sep) ? trimmed : `${process.cwd()}${sep}${trimmed}`;
}

export function claudeHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return fromEnv(env.CLAUDE_CONFIG_DIR) ?? join(home, ".claude");
}

export function codexHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return fromEnv(env.CODEX_HOME) ?? join(home, ".codex");
}

// Claude Code's own state file, which holds its user-scope MCP servers under
// a top-level `mcpServers`: `~/.claude.json` in the home folder itself, not
// inside ~/.claude (https://code.claude.com/docs/en/mcp, "MCP installation
// scopes" and "Scope hierarchy and precedence"). With CLAUDE_CONFIG_DIR set,
// `.claude.json` in that folder: observed on a Mac with CLAUDE_CONFIG_DIR
// set, 2026-10-08, not documented.
export function claudeStateFile(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = fromEnv(env.CLAUDE_CONFIG_DIR);
  return dir === null ? join(home, ".claude.json") : `${dir}${sep}.claude.json`;
}
