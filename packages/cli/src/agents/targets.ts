// What `init` writes for each agent, in which scope. The paths and their
// sources are listed in templates/README.md; this file follows it exactly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetPath } from "../assets.js";
import type { AgentId } from "./detect.js";

export type Scope = "user" | "project";

export type Target =
  // A whole file (rule or skill).
  | { kind: "file"; agent: AgentId; label: string; path: string; content: string; inRepo: boolean; usesLauncher?: boolean }
  // One hook group merged under hooks.PreToolUse of a JSON settings file.
  | { kind: "hook-json"; agent: AgentId; label: string; path: string; group: HookGroup; inRepo: boolean; usesLauncher: boolean }
  // A section between the openqodex markers in a markdown file.
  // `replaces`: other sections we write that this one may replace when one
  // is found exactly as written, recorded or not.
  | { kind: "md-section"; agent: AgentId; label: string; path: string; section: string; inRepo: boolean; replaces?: string[] }
  // Rules merged into permissions.allow of a Claude Code settings file.
  | { kind: "allow-rules"; agent: AgentId; label: string; path: string; rules: string[]; inRepo: boolean };

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
// feature or fix is done. The same text goes into every agent's global
// instruction file, the project CLAUDE.md and AGENTS.md, and the Cursor and
// Cline rules.
export function instructionSection(): string {
  return template("instructions-section.md").trimEnd();
}

function sectionTarget(agent: AgentId, label: string, path: string, inRepo: boolean): Target {
  return { kind: "md-section", agent, label, path, section: instructionSection(), inRepo };
}

// Codex reads its home folder from CODEX_HOME, ~/.codex by default.
function codexHome(home: string): string {
  const fromEnv = process.env.CODEX_HOME;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(home, ".codex");
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

// One level-2 section of the shipped skill, heading included.
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`the shipped skill has no "${heading}" section`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start + 1, end === -1 ? undefined : end).trimEnd();
}

// The user-scope skill: the shipped frontmatter and title, when to run and
// who reviews (so the main agent hands the review to a subagent before
// reading the procedure), then the one command that prints the procedure of
// whatever version the launcher runs. It names no version and no procedure,
// so an update never has to rewrite it.
export function skillStub(launcher: string): string {
  const text = shippedSkill();
  const front = /^---\n[\s\S]*?\n---\n/.exec(text)?.[0];
  const title = /^# .*$/m.exec(text)?.[0];
  if (front === undefined || title === undefined) throw new Error("the shipped skill has no frontmatter or title");
  return [
    front,
    title,
    "",
    section(text, "When to run"),
    "",
    section(text, "Who reviews"),
    "",
    "## Procedure",
    "",
    "Run this from the repository and follow what it prints, from step 1 of its procedure:",
    "",
    "```",
    `${launcher} guide skill`,
    "```",
    "",
    "It prints the full review procedure of the OpenQodex version installed here, with the exact commands to run. Read it each time: it changes when OpenQodex updates.",
    "",
  ].join("\n");
}

// A user-scope rule calls the launcher, and prints the procedure with
// `guide skill` where the project-scope rule says `guide`.
function userRule(text: string, runner: string): string {
  return text.replace(PINNED_NPX, () => runner).replaceAll(`${runner} guide\``, `${runner} guide skill\``);
}

// The exact command lines the skill tells the agent to run, allowed in
// Claude Code without a prompt, in user scope only. A rule with no `*`
// matches one exact command, and "a rule must match each subcommand
// independently" (Claude Code permissions page, Compound commands), so
// `review --agent && other` is not covered. No wildcard after `review`: one
// would pass --output, --config and --cwd with any path unasked. `guide *` is
// the one wildcard: guide only prints a page bundled in the package, chosen
// by name from its docs folder. Not allowed: `scan`, `doctor`, `trust`
// (approving a custom scanner stays the developer's decision), `update`,
// `init`, `report`; `hook check` runs from Claude Code's hook system, which
// needs no Bash rule.
const REVIEW_LINES = ["review --agent", "review --finalize", "review --agent --all", "review --finalize --all"];
const ALLOWED_LINES = [...REVIEW_LINES, ...REVIEW_LINES.map((l) => `${l} --offline`), "guide", "guide *"];

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
    { kind: "md-section", agent: "claude-code", label: "team review section", path: join(repoRoot, "CLAUDE.md"), section, inRepo: true, replaces: [instructionSection()] },
    { kind: "md-section", agent: "codex", label: "team review section", path: join(repoRoot, "AGENTS.md"), section, inRepo: true, replaces: [instructionSection()] },
  ];
}

export function targetsFor(args: {
  agent: AgentId;
  scope: Scope;
  home: string;
  repoRoot: string | null;
  version: string;
  // The quoted launcher, or `npx -y openqodex@<version>` for project files.
  runner: string;
}): { targets: Target[]; skipped: string[] } {
  const { agent, scope, home, repoRoot, version, runner } = args;
  const targets: Target[] = [];
  const skipped: string[] = [];
  const user = scope === "user";
  // Project scope always needs the repo; user scope needs it only for the Cursor rule.
  const base = user ? home : repoRoot;
  if (base === null) return { targets, skipped: [`${agent}: run init --project inside a git repository`] };
  const at = (...p: string[]): string => join(base, ...p);
  const skillText = user ? skillStub(runner) : fill(renderSkill(runner), version);
  // A user-scope skill calls the launcher, so the launcher stays while it is installed.
  const skillTarget = (label: string, path: string): Target => fileTarget(agent, label, path, skillText, !user, user);

  switch (agent) {
    case "claude-code":
      targets.push(skillTarget("Claude Code skill", at(".claude", "skills", "openqodex", "SKILL.md")));
      targets.push(
        user
          ? sectionTarget(agent, "Claude Code global instructions", at(".claude", "CLAUDE.md"), false)
          : sectionTarget(agent, "Claude Code project instructions", at("CLAUDE.md"), true),
      );
      targets.push({
        kind: "hook-json",
        agent,
        label: "Claude Code push hook",
        path: at(".claude", "settings.json"),
        group: hookGroup("claude-code/settings-hook.json", runner),
        inRepo: !user,
        usesLauncher: user,
      });
      if (user && hasRuleWildcard(runner)) {
        skipped.push(`Claude Code permission rules: not written, because the launcher path ${runner} holds *, which Claude Code reads as a wildcard; Claude Code will ask before each review command`);
      }
      // Rules in user scope only: a committed settings file would grant them
      // on every teammate's machine. Project scope gets the target with no
      // rules, so rules an earlier build recorded there are still removed.
      // After the hook: both change settings.json.
      targets.push({
        kind: "allow-rules",
        agent,
        label: "Claude Code permission rules",
        path: at(".claude", "settings.json"),
        rules: user && !hasRuleWildcard(runner) ? allowRules(runner) : [],
        inRepo: !user,
      });
      break;
    case "codex":
      targets.push(skillTarget("Codex skill", at(".agents", "skills", "openqodex", "SKILL.md")));
      targets.push(
        user
          ? sectionTarget(agent, "Codex global instructions", join(codexHome(home), "AGENTS.md"), false)
          : sectionTarget(agent, "Codex instructions", at("AGENTS.md"), true),
      );
      targets.push({
        kind: "hook-json",
        agent,
        label: "Codex push hook",
        path: at(".codex", "hooks.json"),
        group: hookGroup("codex/hooks.json", runner),
        inRepo: !user,
        usesLauncher: user,
      });
      break;
    case "cursor": {
      targets.push(skillTarget("Cursor skill", user ? at(".cursor", "skills", "openqodex", "SKILL.md") : at(".agents", "skills", "openqodex", "SKILL.md")));
      // Cursor has no user-level rule file: the rule always goes in the repo.
      const cursorRule = fill(template("cursor", "openqodex.mdc"), version);
      const rule = user ? userRule(cursorRule, runner) : cursorRule;
      if (repoRoot === null) skipped.push("Cursor rule: run openqodex init inside a git repository to add it there");
      // A user-scope rule calls the launcher, so the launcher stays while it is installed.
      else targets.push(fileTarget(agent, "Cursor rule", join(repoRoot, ".cursor", "rules", "openqodex.mdc"), rule, true, user));
      break;
    }
    case "cline":
      targets.push(skillTarget("Cline skill", at(".cline", "skills", "openqodex", "SKILL.md")));
      targets.push(
        fileTarget(
          agent,
          "Cline rule",
          user ? at("Documents", "Cline", "Rules", "openqodex.md") : at(".clinerules", "openqodex.md"),
          user ? userRule(fill(template("cline", "openqodex.md"), version), runner) : fill(template("cline", "openqodex.md"), version),
          !user,
          user,
        ),
      );
      break;
  }
  return { targets, skipped };
}
