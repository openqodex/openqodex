// Checks the skill and the plugin manifests. A missing or wrong file fails the gate.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const errors = [];

function present(rel) {
  if (existsSync(join(root, rel))) return true;
  errors.push(`${rel}: missing`);
  return false;
}

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(join(root, rel), "utf8"));
  } catch (error) {
    errors.push(`${rel}: not valid JSON (${error.message})`);
    return undefined;
  }
}

const skill = "skills/openqodex/SKILL.md";
if (present(skill)) {
  const text = readFileSync(join(root, skill), "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    errors.push(`${skill}: no frontmatter`);
  } else {
    const front = match[1];
    const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
    const description = front.match(/^description:[ \t]*(.*)$/m)?.[1]?.trim();
    if (name !== "openqodex") errors.push(`${skill}: frontmatter name must be openqodex`);
    if (!description) errors.push(`${skill}: frontmatter description is empty`);
  }
  if (!errors.length) console.log(`ok: ${skill}`);
}

// Each plugin ships a copy of the skill and of the icon, and every pinned
// command and manifest version must name the version being released. All of
// them drift silently unless the gate checks them.
const pluginSkills = ["plugins/claude-code/skills/openqodex/SKILL.md", "plugins/codex/skills/openqodex/SKILL.md"];
const version = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
for (const pluginSkill of pluginSkills) {
  if (present(pluginSkill) && existsSync(join(root, skill))) {
    if (readFileSync(join(root, skill), "utf8") !== readFileSync(join(root, pluginSkill), "utf8")) {
      errors.push(`${pluginSkill}: differs from ${skill}`);
    } else console.log(`ok: ${pluginSkill} matches the skill`);
  }
}
const icon = "assets/avatar-1024.png";
for (const copy of ["plugins/claude-code/assets/avatar-1024.png", "plugins/codex/assets/avatar-1024.png"]) {
  if (present(copy) && present(icon)) {
    if (!readFileSync(join(root, icon)).equals(readFileSync(join(root, copy)))) errors.push(`${copy}: differs from ${icon}`);
    else console.log(`ok: ${copy} matches ${icon}`);
  }
}
for (const rel of [skill, ...pluginSkills, "plugins/claude-code/hooks/hooks.json", ".pre-commit-hooks.yaml"]) {
  if (!existsSync(join(root, rel))) continue;
  const pins = readFileSync(join(root, rel), "utf8").match(/openqodex@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g) ?? [];
  const wrong = [...new Set(pins)].filter((pin) => pin !== `openqodex@${version}`);
  if (wrong.length) errors.push(`${rel}: pins ${wrong.join(", ")} but the package is ${version}`);
}
for (const pluginJson of [
  "plugins/claude-code/.claude-plugin/plugin.json",
  "plugins/codex/.codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
]) {
  if (!existsSync(join(root, pluginJson))) continue;
  const pluginVersion = readJson(pluginJson)?.version;
  if (pluginVersion !== version) errors.push(`${pluginJson}: version ${pluginVersion} but the package is ${version}`);
}

// The OpenAI plugin directory rejects a Codex manifest over these limits
// (https://developers.openai.com/plugins/deploy/submission, field tables).
const codex = "plugins/codex/.codex-plugin/plugin.json";
if (present(codex)) {
  const json = readJson(codex);
  if (json) {
    const before = errors.length;
    const ui = json.interface ?? {};
    const text = (value, max, field) => {
      if (typeof value !== "string" || !value.trim()) errors.push(`${codex}: ${field} is missing`);
      else if (value.length > max) errors.push(`${codex}: ${field} is ${value.length} characters, the limit is ${max}`);
    };
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(json.name ?? "") || json.name.length > 64) errors.push(`${codex}: name must be lowercase words joined by single hyphens, at most 64 characters`);
    text(json.description, 4000, "description");
    text(json.author?.name, 120, "author.name");
    text(ui.displayName, 30, "interface.displayName");
    text(ui.shortDescription, 30, "interface.shortDescription");
    text(ui.longDescription, 4000, "interface.longDescription");
    text(ui.developerName, 80, "interface.developerName");
    text(ui.category, 200, "interface.category");
    const capabilities = ui.capabilities;
    if (!Array.isArray(capabilities) || !capabilities.length || capabilities.length > 20 || capabilities.some((c) => typeof c !== "string" || c.length > 120)) {
      errors.push(`${codex}: interface.capabilities must hold 1 to 20 strings of at most 120 characters`);
    }
    const prompts = ui.defaultPrompt ?? [];
    if (!Array.isArray(prompts) || prompts.length > 3 || prompts.some((p) => typeof p !== "string" || p.length > 128)) {
      errors.push(`${codex}: interface.defaultPrompt must hold at most 3 strings of at most 128 characters`);
    }
    if (!(ui.privacyPolicyURL ?? "").startsWith("https://")) errors.push(`${codex}: interface.privacyPolicyURL must be an https URL`);
    for (const [field, path] of [["skills", json.skills], ["interface.composerIcon", ui.composerIcon], ["interface.logo", ui.logo]]) {
      if (typeof path !== "string" || !path.startsWith("./") || path.includes("..")) errors.push(`${codex}: ${field} must be a ./ path inside the plugin`);
      else if (!existsSync(join(root, "plugins/codex", path))) errors.push(`${codex}: ${field} names ${path}, which is missing`);
    }
    if (errors.length === before) console.log(`ok: ${codex}`);
  }
}

// Cursor reads this manifest at the repo root; its paths may not hold "..".
const cursor = ".cursor-plugin/plugin.json";
if (present(cursor)) {
  const json = readJson(cursor);
  if (json) {
    const before = errors.length;
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(json.name ?? "")) errors.push(`${cursor}: name must be lowercase kebab-case`);
    if (typeof json.description !== "string" || !json.description.trim()) errors.push(`${cursor}: description is missing`);
    if (typeof json.logo === "string") {
      if (json.logo.startsWith("/") || json.logo.split("/").includes("..")) errors.push(`${cursor}: logo must be a relative path without ..`);
      else if (!existsSync(join(root, json.logo))) errors.push(`${cursor}: logo names ${json.logo}, which is missing`);
    }
    if (errors.length === before) console.log(`ok: ${cursor}`);
  }
}

const plugin = "plugins/claude-code/.claude-plugin/plugin.json";
if (present(plugin)) {
  const json = readJson(plugin);
  if (json && typeof json.name !== "string") errors.push(`${plugin}: missing name`);
  else if (json) console.log(`ok: ${plugin}`);
}

const hooks = "plugins/claude-code/hooks/hooks.json";
if (present(hooks)) {
  const json = readJson(hooks);
  if (json && (typeof json.hooks !== "object" || json.hooks === null)) {
    errors.push(`${hooks}: missing top-level hooks`);
  } else if (json) console.log(`ok: ${hooks}`);
}

const marketplace = ".claude-plugin/marketplace.json";
if (present(marketplace)) {
  const json = readJson(marketplace);
  if (json) {
    const before = errors.length;
    if (typeof json.name !== "string") errors.push(`${marketplace}: missing name`);
    if (typeof json.owner?.name !== "string") errors.push(`${marketplace}: missing owner.name`);
    if (!Array.isArray(json.plugins)) errors.push(`${marketplace}: missing plugins list`);
    if (errors.length === before) console.log(`ok: ${marketplace}`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}
