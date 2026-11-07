// What `init` writes for each agent, in which scope. The paths and their
// sources are listed in templates/README.md; this file follows it exactly.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { assetPath } from "../assets.js";
import { AGENT_NAMES, type AgentId } from "./detect.js";
import { claudeHome, claudeStateFile, codexHome } from "./homes.js";
import { MCP_SERVER, tomlBlock } from "./mcp.js";
import shippedSkills from "./shipped-skills.json";

export type Scope = "user" | "project";

export type Target =
  // A whole file (rule or skill). `skillRunner`, on a skill: the command an
  // init here writes for OpenQodex, so a shipped skill text is recognised (isShippedSkill).
  | { kind: "file"; agent: AgentId; label: string; path: string; content: string; inRepo: boolean; usesLauncher?: boolean; skillRunner?: string }
  // One hook group merged under hooks.PreToolUse of a JSON settings file.
  | { kind: "hook-json"; agent: AgentId; label: string; path: string; group: HookGroup; inRepo: boolean; usesLauncher: boolean }
  // A section between the openqodex markers in a markdown file.
  // `replaces`: other sections we write that this one may replace when one
  // is found exactly as written, recorded or not.
  | { kind: "md-section"; agent: AgentId; label: string; path: string; section: string; inRepo: boolean; replaces?: string[] }
  // Rules merged into permissions.allow of a Claude Code settings file.
  | { kind: "allow-rules"; agent: AgentId; label: string; path: string; rules: string[]; inRepo: boolean }
  // The code graph's MCP server under mcpServers.openqodex of a JSON file
  // (src/agents/mcp.ts). `hint`: what the agent asks before it uses it.
  | { kind: "mcp-json"; agent: AgentId; label: string; path: string; entry: Record<string, unknown>; inRepo: boolean; usesLauncher: boolean; hint?: string }
  // The same server as a marked block at the end of Codex's config.toml.
  | { kind: "mcp-toml"; agent: AgentId; label: string; path: string; block: string; inRepo: boolean; usesLauncher: boolean; hint?: string };

export type McpJsonTarget = Extract<Target, { kind: "mcp-json" }>;

export type HookHandler = { type: string; command: string; [key: string]: unknown };
export type HookGroup = { matcher: string; hooks: HookHandler[]; [key: string]: unknown };

export const SECTION_START = "<!-- openqodex:start -->";
export const SECTION_END = "<!-- openqodex:end -->";

function template(...segments: string[]): string {
  return readFileSync(assetPath("templates", ...segments), "utf8");
}

function fill(text: string, version: string): string {
  return text.replaceAll("{{VERSION}}", () => version).replaceAll("{{INSTRUCTIONS}}", () => instructionSection());
}

// The marked section that tells an agent to review with openqodex when a
// feature or fix is done. It goes into the project CLAUDE.md and AGENTS.md
// and into the Cursor and Cline rules. It says when, never how or who: the
// user-scope rules carry it, and an update never rewrites them.
export function instructionSection(): string {
  return template("instructions-section.md").trimEnd();
}

// Previous instruction sections: found exactly as written, init puts the
// current one in their place even where no record names it (a teammate's machine).
// Read only when init renders targets. Update workers import this module
// without rendering any agent files or needing the templates beside them.
export function previousInstructionSections(): string[] {
  return [
    template("previous", "instructions-0.2.0.md").trimEnd(),
    template("previous", "instructions-0.5.0.md").trimEnd(),
    template("previous", "instructions-0.8.2.md").trimEnd(),
  ];
}

// The marked section for each agent's global instruction file: one line
// that names the skill. The global file is read in every repository, so it
// carries only the trigger; the skill holds the procedure, and a repo's own
// team section says how that repo reviews.
export function globalSection(): string {
  return template("global-section.md").trimEnd();
}

function sectionTarget(agent: AgentId, label: string, path: string, inRepo: boolean): Target {
  if (!inRepo) return { kind: "md-section", agent, label, path, section: globalSection(), inRepo };
  return { kind: "md-section", agent, label, path, section: instructionSection(), inRepo, replaces: previousInstructionSections() };
}

// The hook group from a JSON template, with the command put in after
// parsing so no path can break the JSON.
function hookGroup(file: string, runner: string): HookGroup {
  const parsed = JSON.parse(template(file)) as { hooks: { PreToolUse: HookGroup[] } };
  const group = parsed.hooks.PreToolUse[0];
  for (const h of group.hooks) h.command = h.command.replace("{{LAUNCHER}}", () => runner);
  return group;
}

// The skill's one paragraph for a copy installed by `npx skills add`, which
// has no launcher of its own. Every copy init writes or `guide skill` prints
// drops it: a user-scope runner already is the launcher, and a project-scope
// skill keeps the version the team committed.
const LAUNCHER_PARAGRAPH = /^When the file `~\/\.openqodex\/bin\/openqodex` exists[^\n]*\n\n/m;
const PINNED_NPX = /npx -y openqodex@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

function shippedSkill(): string {
  return readFileSync(assetPath("skills", "openqodex", "SKILL.md"), "utf8");
}

// The full procedure as shipped, with every `npx -y openqodex@<version>`
// replaced by `runner`: the launcher, or the pinned npx form of this version.
export function renderSkill(runner: string): string {
  return shippedSkill().replace(LAUNCHER_PARAGRAPH, "").replace(PINNED_NPX, () => runner);
}

// The key of one exact skill text, with the two things that differ between
// copies of one shipped text written as placeholders: the version a pin
// names, and the command that runs OpenQodex (`npx -y openqodex@<version>`,
// or `runner`, the launcher or pinned npx form an init on this machine
// writes in its place). Nothing else is taken out: an edit anywhere, the
// launcher paragraph included, changes the key. The placeholders hold a NUL,
// which no skill file holds, so a file that spells a placeholder out is a
// user edit and matches nothing (isShippedSkill refuses a NUL outright).
// scripts/validate-skill.mjs computes the same key.
const ANY_PIN = /openqodex@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;
const VERSION_TOKEN = "openqodex@\u0000version\u0000";
const RUNNER_TOKEN = "\u0000runner\u0000";
function skillKey(text: string, runner: string | null): string {
  const own = runner === null ? text : text.replaceAll(runner, RUNNER_TOKEN);
  return createHash("sha256").update(own.replace(ANY_PIN, VERSION_TOKEN).replaceAll(`npx -y ${VERSION_TOKEN}`, RUNNER_TOKEN)).digest("hex");
}

// The keys a shipped text adds to shipped-skills.json: the file as shipped
// (what `npx skills add` copies), and the file without its launcher
// paragraph (what an earlier init wrote, in either scope).
export function shippedSkillKeys(shipped: string): string[] {
  return [skillKey(shipped, null), skillKey(shipped.replace(LAUNCHER_PARAGRAPH, ""), null)];
}

// True when `text` is exactly the skill as some version shipped it, or as
// an earlier init wrote it with `runner` in place of npx. Such a file is
// OpenQodex's, not the developer's, so init replaces it; a copy the
// developer edited anywhere matches none.
const SHIPPED = new Set(shippedSkills.sha256);
export function isShippedSkill(text: string, runner: string): boolean {
  return !text.includes("\u0000") && SHIPPED.has(skillKey(text, runner));
}

// The user-scope files carry no procedure, no reviewer and no version, so
// an update never has to rewrite them: when to review, and the one command
// that prints the procedure of whatever version the launcher runs. They
// change only with a new agentContract (src/contract.ts), and
// test/agent-contract.test.ts holds them to the copy checked in for it.
function withLauncher(text: string, launcher: string): string {
  return text.replaceAll("{{LAUNCHER}}", () => launcher).replaceAll("{{INSTRUCTIONS}}", () => instructionSection());
}

// The user-scope skill (templates/skill-stub.md).
export function skillStub(launcher: string): string {
  return withLauncher(template("skill-stub.md"), launcher);
}

// The user-scope Cursor or Cline rule: the instruction section, then the
// launcher's `guide skill`.
function userRule(file: string, launcher: string): string {
  return withLauncher(template(...file.split("/")), launcher);
}

// The exact command lines the skill tells the agent to run, allowed in
// Claude Code without a prompt, in user scope only. A rule with no `*`
// matches one exact command, and "a rule must match each subcommand
// independently" (Claude Code permissions page, Compound commands), so
// `review && other` is not covered. No wildcard after `review`: one
// would pass --output, --config and --cwd with any path unasked. `guide *` is
// the one wildcard: guide only prints a page bundled in the package, chosen
// by name from its docs folder. Not allowed: `scan`, `doctor`, `trust`
// (approving a custom scanner stays the developer's decision), `update`,
// `init`, `report`; `hook check` runs from Claude Code's hook system, which
// needs no Bash rule. The two-step lines of older versions (`review --agent`,
// `review --finalize`) are no longer granted; init removes the ones it recorded.
// `findings *` is the other wildcard: its argument is whichever numbers the
// developer named, which no exact line can list, and findings only reads the
// last review's report and prints it (it takes no flag but --cwd).
// `graph *` is the third: its arguments are a question about the code (a
// name, a file and line), which no exact line can list. graph only reads the
// repository and writes nothing but that repository's own `.openqodex/graph/`
// folder and its local refs `refs/openqodex/graph/<tree>`; it takes no
// output path. Like `findings *` it accepts --cwd, and it accepts --config,
// which names the config file it reads.
// No rule for the MCP server's tools. A rule such as `mcp__openqodex`
// matches every tool of any server of that name (permissions page, "MCP":
// "`mcp__puppeteer` matches any tool provided by the `puppeteer` server"),
// and a project's `.mcp.json` or a local-scope entry, which take precedence
// over the user-scope server init registers, can name another server so.
// Claude Code asks before the server's tools run. A rule an earlier build
// recorded is removed by the next init.
const REVIEW_LINES = ["review", "review --all"];
const ALLOWED_LINES = [...REVIEW_LINES, ...REVIEW_LINES.map((l) => `${l} --offline`), "guide", "guide *", "findings *", "graph *"];

export function allowRules(runner: string): string[] {
  return ALLOWED_LINES.map((l) => `Bash(${runner} ${l})`);
}

// A character Claude Code's rule syntax reads as a wildcard. Its permissions
// page names `*` (and the older `:*` suffix, which needs `*` too); a launcher
// path holding one would turn an exact rule into a pattern.
export function hasRuleWildcard(runner: string): boolean {
  return runner.includes("*");
}

function fileTarget(agent: AgentId, label: string, path: string, content: string, inRepo: boolean, usesLauncher = false): Target {
  return { kind: "file", agent, label, path, content, inRepo, usesLauncher };
}

// The section for the repo's own CLAUDE.md and AGENTS.md, written by a
// user-scope init so a teammate with nothing installed reviews too. It names
// only the pinned npx command, never the skill or the launcher.
export function teamSection(version: string): string {
  return fill(template("repo", "team-section.md"), version).trimEnd();
}

export function teamTargets(repoRoot: string, version: string): Target[] {
  const section = teamSection(version);
  return [
    { kind: "md-section", agent: "claude-code", label: "team review section", path: join(repoRoot, "CLAUDE.md"), section, inRepo: true, replaces: [instructionSection(), ...previousInstructionSections()] },
    { kind: "md-section", agent: "codex", label: "team review section", path: join(repoRoot, "AGENTS.md"), section, inRepo: true, replaces: [instructionSection(), ...previousInstructionSections()] },
  ];
}

// The Cline CLI's own folder for its data and settings, where its MCP file
// lives. `init` never makes it (the skill goes to ~/.cline/skills), so it
// tells the CLI apart from the VS Code extension, which reads another file.
export function clineCliData(home: string): string {
  return join(home, ".cline", "data");
}

export function targetsFor(args: {
  agent: AgentId;
  scope: Scope;
  home: string;
  repoRoot: string | null;
  version: string;
  // The quoted launcher, or `npx -y openqodex@<version>` for project files.
  runner: string;
  // The launcher's absolute path, unquoted: an MCP entry's command runs
  // with no shell.
  launcher: string;
  // Whether the Cline CLI's data folder (clineCliData) is there.
  clineCli: boolean;
}): { targets: Target[]; skipped: string[]; mcpNotes: string[] } {
  const { agent, scope, home, repoRoot, version, runner, launcher, clineCli } = args;
  const targets: Target[] = [];
  const skipped: string[] = [];
  // What the developer adds by hand where init writes no MCP file.
  const mcpNotes: string[] = [];
  const user = scope === "user";
  // Project scope always needs the repo; user scope needs it only for the Cursor rule.
  const base = user ? home : repoRoot;
  if (base === null) return { targets, skipped: [`${agent}: run init --project inside a git repository`], mcpNotes };
  const at = (...p: string[]): string => join(base, ...p);
  // In user scope, Claude Code's and Codex's own folders, as homes.ts finds
  // them, joined without folding `..`: the write check resolves the path the
  // way the system does (real-path.ts).
  const claude = (...p: string[]): string => (user ? [claudeHome(home), ...p].join(sep) : at(".claude", ...p));
  const codex = (...p: string[]): string => (user ? [codexHome(home), ...p].join(sep) : at(".codex", ...p));
  const skillText = user ? skillStub(runner) : fill(renderSkill(runner), version);
  // A user-scope skill calls the launcher, so the launcher stays while it is installed.
  const skillTarget = (label: string, path: string): Target => ({ kind: "file", agent, label, path, content: skillText, inRepo: !user, usesLauncher: user, skillRunner: runner });
  // The code graph's MCP server, stdio only: the launcher in user scope, the
  // pinned npx form in project scope, which a teammate's machine can run.
  const server = user ? { command: launcher, args: ["mcp"] } : { command: "npx", args: ["-y", `openqodex@${version}`, "mcp"] };
  const mcpLabel = `${AGENT_NAMES[agent]} MCP server for the code graph`;
  const mcpJson = (path: string, entry: Record<string, unknown>, hint?: string): McpJsonTarget => ({ kind: "mcp-json", agent, label: mcpLabel, path, entry, inRepo: !user, usesLauncher: user, ...(hint ? { hint } : {}) });

  switch (agent) {
    case "claude-code":
      targets.push(skillTarget("Claude Code skill", claude("skills", "openqodex", "SKILL.md")));
      targets.push(
        user
          ? sectionTarget(agent, "Claude Code global instructions", claude("CLAUDE.md"), false)
          : sectionTarget(agent, "Claude Code project instructions", at("CLAUDE.md"), true),
      );
      targets.push({
        kind: "hook-json",
        agent,
        label: "Claude Code push hook",
        path: claude("settings.json"),
        group: hookGroup("claude-code/settings-hook.json", runner),
        inRepo: !user,
        usesLauncher: user,
      });
      if (user && hasRuleWildcard(runner)) {
        skipped.push(`Claude Code permission rules: not written, because the launcher path ${runner} holds *, which Claude Code reads as a wildcard; Claude Code will ask before each review command`);
      }
      // https://code.claude.com/docs/en/mcp: user scope in the top-level
      // mcpServers of .claude.json (homes.ts), project scope in .mcp.json at
      // the repository root; an entry with type "stdio" runs a local command.
      targets.push(
        user
          ? mcpJson(claudeStateFile(home), { type: "stdio", ...server })
          : mcpJson(at(".mcp.json"), { type: "stdio", ...server }, "Claude Code asks you to approve a project server before it uses it"),
      );
      // Rules in user scope only: a committed settings file would grant them
      // on every teammate's machine. Project scope gets the target with no
      // rules, so rules an earlier build recorded there are still removed.
      // After the hook: both change settings.json.
      const granted = user && !hasRuleWildcard(runner);
      targets.push({
        kind: "allow-rules",
        agent,
        label: "Claude Code permission rules",
        path: claude("settings.json"),
        rules: granted ? allowRules(runner) : [],
        inRepo: !user,
      });
      break;
    case "codex":
      targets.push(skillTarget("Codex skill", at(".agents", "skills", "openqodex", "SKILL.md")));
      targets.push(
        user
          ? sectionTarget(agent, "Codex global instructions", codex("AGENTS.md"), false)
          : sectionTarget(agent, "Codex instructions", at("AGENTS.md"), true),
      );
      targets.push({
        kind: "hook-json",
        agent,
        label: "Codex push hook",
        path: codex("hooks.json"),
        group: hookGroup("codex/hooks.json", runner),
        inRepo: !user,
        usesLauncher: user,
      });
      // https://learn.chatgpt.com/docs/extend/mcp?surface=cli, "Configure
      // with config.toml" and "STDIO servers": a [mcp_servers.<name>] table
      // with command and args, in $CODEX_HOME/config.toml or, for trusted
      // projects only, .codex/config.toml in the repository.
      targets.push({
        kind: "mcp-toml",
        agent,
        label: mcpLabel,
        path: codex("config.toml"),
        block: tomlBlock(server.command, server.args),
        inRepo: !user,
        usesLauncher: user,
        ...(user ? {} : { hint: "Codex reads a project's .codex/config.toml only in a trusted project" }),
      });
      break;
    case "cursor": {
      targets.push(skillTarget("Cursor skill", user ? at(".cursor", "skills", "openqodex", "SKILL.md") : at(".agents", "skills", "openqodex", "SKILL.md")));
      // Cursor has no user-level rule file: the rule always goes in the repo.
      const rule = user ? userRule("cursor/openqodex-user.mdc", runner) : fill(template("cursor", "openqodex.mdc"), version);
      if (repoRoot === null) skipped.push("Cursor rule: run openqodex init inside a git repository to add it there");
      // A user-scope rule calls the launcher, so the launcher stays while it is installed.
      else targets.push(fileTarget(agent, "Cursor rule", join(repoRoot, ".cursor", "rules", "openqodex.mdc"), rule, true, user));
      // https://cursor.com/docs/context/mcp, "Configuration locations" and
      // the STDIO server table: ~/.cursor/mcp.json, or .cursor/mcp.json in
      // the project, with type "stdio".
      targets.push(mcpJson(at(".cursor", "mcp.json"), { type: "stdio", ...server }));
      break;
    }
    case "cline":
      targets.push(skillTarget("Cline skill", at(".cline", "skills", "openqodex", "SKILL.md")));
      targets.push(
        fileTarget(
          agent,
          "Cline rule",
          user ? at("Documents", "Cline", "Rules", "openqodex.md") : at(".clinerules", "openqodex.md"),
          user ? userRule("cline/openqodex-user.md", runner) : fill(template("cline", "openqodex.md"), version),
          !user,
          user,
        ),
      );
      // https://docs.cline.bot/mcp/configuring-mcp-servers names the CLI's
      // file, ~/.cline/data/settings/cline_mcp_settings.json, and no project
      // file; the VS Code extension's file is not documented there, so the
      // developer adds the server there by hand.
      if (user && clineCli) targets.push(mcpJson(at(".cline", "data", "settings", "cline_mcp_settings.json"), { ...server }));
      else {
        const why = user ? "not written: init writes only the Cline CLI's file, and ~/.cline/data is not here" : "not written: Cline documents no project MCP file";
        mcpNotes.push(`${mcpLabel}: ${why}. Add it in Cline's "Configure MCP Servers": "${MCP_SERVER}": ${JSON.stringify(server)}`);
      }
      break;
  }
  return { targets, skipped, mcpNotes };
}
