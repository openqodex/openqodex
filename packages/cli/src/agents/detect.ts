// Which coding agents are on this machine.
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { claudeHome, codexHome } from "./homes.js";

export const AGENTS = ["claude-code", "cursor", "codex", "cline", "goose"] as const;
export type AgentId = (typeof AGENTS)[number];

export const AGENT_NAMES: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex CLI",
  cline: "Cline",
  goose: "Goose",
};

function onPath(command: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // not in this folder
    }
  }
  return false;
}

// Cline's VS Code extension id is saoudrizwan.claude-dev (its marketplace page).
function clineExtension(home: string): boolean {
  try {
    return readdirSync(join(home, ".vscode", "extensions")).some((name) => name.startsWith("saoudrizwan.claude-dev-"));
  } catch {
    return false;
  }
}

// An agent counts when its program is on PATH or the folder it reads its
// settings from exists: CLAUDE_CONFIG_DIR and CODEX_HOME when set (homes.ts).
export function detectAgents(home: string = homedir()): AgentId[] {
  const found: AgentId[] = [];
  if (onPath("claude") || existsSync(claudeHome(home))) found.push("claude-code");
  if (existsSync(join(home, ".cursor")) || existsSync("/Applications/Cursor.app")) found.push("cursor");
  if (onPath("codex") || existsSync(codexHome(home))) found.push("codex");
  if (existsSync(join(home, ".cline")) || clineExtension(home)) found.push("cline");
  // Goose keeps its config in ~/.config/goose on macOS and Linux
  // (https://goose-docs.ai/docs/guides/using-goosehints).
  if (onPath("goose") || existsSync(join(home, ".config", "goose"))) found.push("goose");
  return found;
}
