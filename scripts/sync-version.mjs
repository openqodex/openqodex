// Writes the CLI package version into every file that pins it: the skill, its
// plugin copies, the three plugin manifests, the plugin hook and MCP server, the agent
// install line in the README and the quickstart, and the agent guide. Run after `changeset
// version`; the gate fails when any of them differs from the package version.
// It also gives each release notice marked "next" (packages/cli/src/notices.ts)
// the version changesets just chose, so the notice prints after the update
// to that release.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;

for (const rel of [
  "skills/openqodex/SKILL.md",
  "plugins/claude-code/skills/openqodex/SKILL.md",
  "plugins/codex/skills/openqodex/SKILL.md",
  "plugins/claude-code/hooks/hooks.json",
  "plugins/claude-code/.mcp.json",
  ".pre-commit-hooks.yaml",
  "README.md",
  "docs/quickstart.md",
  "docs/for-agents.md",
]) {
  const file = join(root, rel);
  const before = readFileSync(file, "utf8");
  const after = before.replace(/openqodex@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, `openqodex@${version}`);
  if (after !== before) writeFileSync(file, after);
  console.log(`${after === before ? "unchanged" : "updated"}: ${rel}`);
}

// The Action's default version and the docs example that pins a release tag.
for (const [rel, pattern, replacement] of [
  ["action.yml", /^(    default: ")\d[^"]*(")$/m, `$1${version}$2`],
  ["docs/github-action.md", /rev: v\d[^\s]*/, `rev: v${version}`],
]) {
  const file = join(root, rel);
  const before = readFileSync(file, "utf8");
  const after = before.replace(pattern, replacement);
  if (after !== before) writeFileSync(file, after);
  console.log(`${after === before ? "unchanged" : "updated"}: ${rel}`);
}

for (const rel of [
  "plugins/claude-code/.claude-plugin/plugin.json",
  "plugins/codex/.codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
]) {
  const pluginFile = join(root, rel);
  const plugin = JSON.parse(readFileSync(pluginFile, "utf8"));
  if (plugin.version !== version) {
    plugin.version = version;
    writeFileSync(pluginFile, `${JSON.stringify(plugin, null, 2)}\n`);
    console.log(`updated: ${rel}`);
  }
}

// The first release that reads a key, until that release is cut
// (packages/core/src/reviewers.ts): the version changesets chose, once.
{
  const rel = "packages/core/src/reviewers.ts";
  const file = join(root, rel);
  const before = readFileSync(file, "utf8");
  const after = before.replace(/= "\d+\.\d+\.\d+"; \/\/ release: next/g, `= "${version}";`);
  if (after !== before) writeFileSync(file, after);
  console.log(`${after === before ? "unchanged" : "updated"}: ${rel}`);
}

// The release notices of changes this release carries.
{
  const rel = "packages/cli/src/notices.ts";
  const file = join(root, rel);
  const before = readFileSync(file, "utf8");
  const after = before.replace(/version: "next",/g, `version: "${version}",`);
  if (after !== before) writeFileSync(file, after);
  console.log(`${after === before ? "unchanged" : "updated"}: ${rel}`);
}
