// Writes dist/openqodex-codex-plugin-<version>.zip, the package uploaded to the
// OpenAI plugin directory. The ZIP holds the files git tracks under
// plugins/codex, with .codex-plugin/plugin.json at its root, so a private note
// or a build leftover in that folder never reaches the upload. Run
// `node scripts/validate-skill.mjs` first: it checks the manifest and that the
// skill copy matches skills/openqodex/SKILL.md.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, "plugins", "codex");
const { version } = JSON.parse(readFileSync(join(plugin, ".codex-plugin", "plugin.json"), "utf8"));

const files = execFileSync("git", ["ls-files", "-z", "--", "plugins/codex"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .map((file) => relative("plugins/codex", file))
  .sort();
if (!files.includes(".codex-plugin/plugin.json")) {
  console.error("plugins/codex/.codex-plugin/plugin.json is not tracked by git");
  process.exit(1);
}

const out = join(root, "dist", `openqodex-codex-plugin-${version}.zip`);
mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
// -X leaves out extra file attributes, so the ZIP holds only the listed files.
execFileSync("zip", ["-X", "-q", out, ...files], { cwd: plugin, stdio: "inherit" });
console.log(`wrote ${relative(root, out)} with ${files.length} file(s)`);
