// Where Claude Code, Codex and Goose keep their own files. Claude Code's and
// Codex's come from the review package's agents/homes.ts, where the Claude
// Code driver reads them too.
import { isAbsolute, join } from "node:path";

export { claudeHome, claudeStateFile, codexHome } from "@openqodex/review";

// Goose's config folder, as Goose's Paths::config_dir finds it
// (crates/goose/src/config/paths.rs): $GOOSE_PATH_ROOT/config, else
// $XDG_CONFIG_HOME/goose, else ~/.config/goose. Each variable counts only
// when it holds an absolute path, as Goose and its etcetera crate require.
// Windows, where Goose uses another folder, is not handled.
export function gooseHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.GOOSE_PATH_ROOT;
  if (root && isAbsolute(root)) return join(root, "config");
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), "goose");
}
