// `openqodex init`: installs OpenQodex into the developer's coding agents in
// one step. User scope by default, so one install works in every repo and the
// agent files stay out of the repo's git status; `--project` writes them into
// the repo for a team to commit. Inside a repo it also asks about the git
// pre-push hook and creates the two team files in `.openqodex/`.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { FOLDER_CONFIG, INSTRUCTIONS_FILE, STATE_DIR, repoStat } from "@openqodex/core";
import { AGENT_NAMES, AGENTS, detectAgents, type AgentId } from "../agents/detect.js";
import { readText } from "../agents/files.js";
import { excludeLine, gitPath, planExclude, planUnexclude, repoRootOf, trackedFiles } from "../agents/git.js";
import { planInstall, planUninstall, type Action, type Ctx } from "../agents/plan.js";
import { withBoundary } from "../agents/lock.js";
import { loadRecord, saveRecord, serialize, type InstallRecord } from "../agents/record.js";
import { INSTRUCTIONS_LINE, planRepoFiles, planRepoFilesRemoval, ROOT_CONFIG_NOTE } from "../agents/repo-folder.js";
import { instructionSection, targetsFor, teamSection, teamTargets, type Scope, type Target } from "../agents/targets.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { launcherPath, launcherRunner, launcherUsers, openqodexHomeDir, planRuntime, planRuntimeRemoval, pruneRuntimes, removeOldLocks } from "../launcher.js";
import { planGitHook, planGitHookRemoval, setHookChoice } from "./hook.js";

type HookChoice = "pre-push" | "none";

type Flags = { agents: AgentId[]; project: boolean; yes: boolean; uninstall: boolean; dryRun: boolean; hook: HookChoice | null; noRepo: boolean };

const USAGE =
  "usage: openqodex init [--agent <claude-code|cursor|codex|cline|all>]... [--project] [--hook <pre-push|none>] [--no-repo] [--yes] [--uninstall] [--dry-run]";

const HOOK_QUESTION = "Add the git pre-push hook, so every push from this repo gets a scan, from an agent or by hand?";
const TEAM_QUESTION = "Add a review section to this repo's CLAUDE.md and AGENTS.md, so teammates' agents review before they push too?";

function parseFlags(args: string[]): Flags | string {
  const flags: Flags = { agents: [], project: false, yes: false, uninstall: false, dryRun: false, hook: null, noRepo: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project") flags.project = true;
    else if (arg === "--no-repo") flags.noRepo = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--uninstall") flags.uninstall = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--hook" || arg.startsWith("--hook=")) {
      const value = arg === "--hook" ? args[++i] : arg.slice("--hook=".length);
      if (value !== "pre-push" && value !== "none") return `unknown hook: ${value ?? "(missing)"}. Choose pre-push or none.`;
      flags.hook = value;
    }    else if (arg === "--agent" || arg.startsWith("--agent=")) {
      const value = arg === "--agent" ? args[++i] : arg.slice("--agent=".length);
      if (value === "all") flags.agents.push(...AGENTS);
      else if ((AGENTS as readonly string[]).includes(value)) flags.agents.push(value as AgentId);
      else return `unknown agent: ${value ?? "(missing)"}. Choose claude-code, cursor, codex, cline or all.`;
    } else return `unknown argument: ${arg}`;
  }
  flags.agents = AGENTS.filter((a) => flags.agents.includes(a));
  return flags;
}

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function confirm(question: string): Promise<boolean> {
  const prompts = await import("@clack/prompts");
  const answer = await prompts.confirm({ message: question, initialValue: true });
  return !prompts.isCancel(answer) && answer === true;
}

// The answer to the hook question: the flag, then the answer this repo gave
// before, then --yes; null when it must be asked.
function knownHookChoice(s: Setup, record: InstallRecord): HookChoice | null {
  if (s.flags.hook !== null) return s.flags.hook;
  const before = record.hookChoices.find((c) => c.repo === s.repoRoot);
  if (before) return before.hook;
  return s.flags.yes ? "pre-push" : null;
}

// The answer to the team section question: --no-repo or --yes on this
// command line, then the answer this repo gave before; null when it must be asked.
function knownTeamChoice(s: Setup, record: InstallRecord): boolean | null {
  if (s.flags.noRepo) return false;
  if (s.flags.yes) return true;
  return record.teamChoices.find((c) => c.repo === s.repoRoot)?.write ?? null;
}

function setTeamChoice(record: InstallRecord, repo: string, write: boolean): void {
  record.teamChoices = record.teamChoices.filter((c) => c.repo !== repo);
  record.teamChoices.push({ repo, write });
}

// The team section in the repo's CLAUDE.md and AGENTS.md, planned apart from
// the agents: it is the team's, not one agent's. A link on the way refuses
// both files with the reason.
// True when the repo's git ignore rules hide this untracked path: a section
// written there would never show in git status to be committed.
function ignoredByGit(repoRoot: string, path: string): boolean {
  return spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: repoRoot }).status === 0;
}

function planTeam(s: Setup, record: InstallRecord): Action[] {
  const ctx: Ctx = { record, scope: s.scope, repoRoot: s.repoRoot };
  try {
    const actions: Action[] = [];
    for (const t of teamTargets(s.repoRoot!, s.version)) {
      if (!s.flags.uninstall && ignoredByGit(s.repoRoot!, t.path)) {
        actions.push({ verb: "skip", path: t.path, note: `team review section not written: ${relative(s.repoRoot!, t.path)} is in this repo's git ignore rules, so it could not be committed` });
        continue;
      }
      const a = s.flags.uninstall ? planUninstall(t, ctx) : planInstall(t, ctx);
      if (a) actions.push({ ...a, agent: undefined });
    }
    return actions;
  } catch (error) {
    return [{ verb: "refuse", failed: true, path: "-", note: `team review section not ${s.flags.uninstall ? "removed" : "written"}: ${message(error)}` }];
  }
}

// Starts the scanner installs this repo will need, outside any agent sandbox.
// Never fails init: the review installs on first use anyway.
async function startScannerInstalls(repoRoot: string): Promise<void> {
  try {
    const { ADAPTERS, installToolsDetached } = await import("@openqodex/scanners");
    const files = await trackedFiles(repoRoot);
    const wanted = ADAPTERS.filter((a) => a.wants(files, repoRoot)).map((a) => a.source);
    if (wanted.length === 0) return;
    installToolsDetached(wanted);
    out(`Installing the scanners this repo needs in the background: ${wanted.join(", ")}.`);
  } catch (error) {
    process.stderr.write(`openqodex: could not start the scanner installs (${message(error)}); they install on first review instead\n`);
  }
}

type Setup = {
  flags: Flags;
  agents: AgentId[];
  scope: Scope;
  home: string;
  oqHome: string;
  repoRoot: string | null;
  version: string;
};

function collectTargets(s: Setup): { targets: Target[]; notes: string[] } {
  const runner = s.flags.project ? `npx -y openqodex@${s.version}` : launcherRunner(launcherPath(s.oqHome));
  const targets: Target[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const agent of s.agents) {
    const r = targetsFor({ agent, scope: s.scope, home: s.home, repoRoot: s.repoRoot, version: s.version, runner });
    notes.push(...r.skipped);
    for (const t of r.targets) {
      // Two agents can share a project skill path (.agents/skills); the hook
      // and the permission rules share settings.json.
      const key = `${t.kind} ${t.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(t);
    }
  }
  return { targets, notes };
}

// Plans one agent's targets. A file that cannot be read, or a repo path
// through a symlink, stops that agent with the reason.
async function planAgents(s: Setup, record: InstallRecord, targets: Target[]): Promise<Action[]> {
  const ctx: Ctx = { record, scope: s.scope, repoRoot: s.repoRoot };
  const excludeFile = s.repoRoot !== null && !s.flags.project ? await gitPath(s.repoRoot, "info/exclude") : null;
  const actions: Action[] = [];
  for (const agent of s.agents) {
    const mine = targets.filter((t) => t.agent === agent);
    const planned: Action[] = [];
    try {
      for (const t of mine) {
        if (s.flags.uninstall) {
          const a = planUninstall(t, ctx);
          if (a) planned.push(a);
        } else planned.push(planInstall(t, ctx));
        // A repo file written in user scope is hidden from git status.
        if (excludeFile !== null && t.kind === "file" && t.inRepo) {
          const line = excludeLine(s.repoRoot!, t.path);
          const last = planned[planned.length - 1];
          // A rule the developer edited or owns stays, and so does its exclude line.
          const stays = last !== undefined && (last.verb === "keep" || last.verb === "refuse");
          if (stays) continue;
          if (s.flags.uninstall) {
            const a = planUnexclude(excludeFile, line, s.repoRoot!, record);
            if (a) planned.push(a);
          } else planned.push(planExclude(excludeFile, line, s.repoRoot!, record));
        }
      }
    } catch (error) {
      actions.push({ verb: "refuse", failed: true, path: "-", agent, note: `${AGENT_NAMES[agent]} not ${s.flags.uninstall ? "removed" : "installed"}: ${message(error)}` });
      continue;
    }
    actions.push(...planned);
  }
  return actions;
}

function printPlan(actions: Action[], notes: string[]): void {
  for (const a of actions) out(`  ${a.verb.padEnd(8)} ${a.path}  (${a.note})`);
  for (const note of notes) out(`  note     ${note}`);
}

function printSection(actions: Action[], targets: Target[]): void {
  const writes = new Set(actions.filter((a) => a.apply).map((a) => a.path));
  const labels = targets.filter((t) => t.kind === "md-section" && writes.has(t.path)).map((t) => t.label);
  if (labels.length === 0) return;
  out(`The instruction section init writes into ${labels.join(" and ")}:`);
  for (const line of instructionSection().split("\n")) out(`    ${line}`);
}

async function runLocked(s: Setup): Promise<number> {
  const record = loadRecord(s.oqHome);
  const recordBefore = serialize(record);
  const { targets, notes } = collectTargets(s);
  if (!s.flags.uninstall && s.agents.includes("cursor") && s.repoRoot !== null) {
    notes.push("Cursor has no global instruction file: its rule in this repo carries the same section");
  }
  const actions: Action[] = [];
  const runtimeActions = new Set<Action>();
  let failed = false;

  const agentActions = await planAgents(s, record, targets);
  let rootConfig = false;
  let hookChoice: HookChoice | null = null;
  if (s.flags.uninstall) {
    actions.push(...agentActions);
    if (s.repoRoot !== null) {
      actions.push(...(await planRepoFilesRemoval(s.repoRoot, record)));
      const hook = await planGitHookRemoval(s.repoRoot, record, s.oqHome);
      if (hook) actions.push(hook);
      record.hookChoices = record.hookChoices.filter((c) => c.repo !== s.repoRoot);
      if (!s.flags.project) {
        actions.push(...planTeam(s, record));
        record.teamChoices = record.teamChoices.filter((c) => c.repo !== s.repoRoot);
      }
    }
  } else {
    // Every user-scope install gets the runtime and the launcher: the skill
    // calls it even where no hook does.
    const needsLauncher = s.scope === "user" || targets.some((t) => t.kind === "hook-json" && t.usesLauncher);
    const runtime = needsLauncher ? planRuntime(record, s.version, s.oqHome) : [];
    for (const a of runtime) runtimeActions.add(a);
    actions.push(...runtime, ...agentActions);
    if (s.repoRoot !== null) {
      const repo = planRepoFiles(s.repoRoot, record);
      rootConfig = repo.rootConfig;
      actions.push(...repo.actions);
      hookChoice = knownHookChoice(s, record);
    }
    if (runtime.some((a) => a.failed)) {
      out(`OpenQodex ${s.version} install plan (${s.scope} scope):`);
      printPlan(actions, notes);
      process.stderr.write("openqodex init: nothing was written; the launcher hooks call cannot be set up (see above)\n");
      return EXIT_TOOL_FAILED;
    }
  }

  if (s.flags.uninstall && !s.flags.project) {
    // Hook files this run leaves alone (another agent, a file that could not
    // be parsed) still call the launcher.
    const touched = new Set(actions.filter((a) => a.apply).map((a) => a.path));
    const willStay = launcherUsers(record).filter((p) => !touched.has(p));
    actions.push(...planRuntimeRemoval(record, s.oqHome, willStay));
  }

  out(s.flags.uninstall ? "OpenQodex uninstall plan:" : `OpenQodex ${s.version} install plan (${s.scope} scope):`);
  printPlan(actions, notes);
  if (!s.flags.uninstall) printSection(actions, targets);

  // The hook question, asked after the plan is shown.
  if (!s.flags.uninstall && s.repoRoot !== null) {
    if (hookChoice === null && !s.flags.dryRun && interactive()) hookChoice = (await confirm(HOOK_QUESTION)) ? "pre-push" : "none";
    if (hookChoice === null) {
      out(`  note     git pre-push hook: ${s.flags.dryRun ? "init will ask whether to add it" : "not asked without a terminal; run init with --hook pre-push to add it"}`);
    } else {
      if (!s.flags.dryRun) setHookChoice(record, s.repoRoot, hookChoice);
      if (hookChoice === "pre-push") {
        const more: Action[] = [];
        if (runtimeActions.size === 0) {
          const runtime = planRuntime(record, s.version, s.oqHome);
          for (const a of runtime) runtimeActions.add(a);
          // The runtime goes first: the hook calls it.
          actions.unshift(...runtime);
          more.push(...runtime);
        }
        const hook = await planGitHook(s.repoRoot, record, s.oqHome, false);
        actions.push(hook.action);
        more.push(hook.action);
        printPlan(more, []);
        if (more.some((a) => a.failed)) {
          process.stderr.write("openqodex init: nothing was written; the launcher the git hook calls cannot be set up (see above)\n");
          return EXIT_TOOL_FAILED;
        }
      } else out("  note     git pre-push hook: not added (add it later with npx openqodex hook install)");
    }
  }

  // The team section question, in user scope inside a repo. Project scope
  // already writes its own section into the same two files.
  const teamActions: Action[] = [];
  if (!s.flags.uninstall && !s.flags.project && s.repoRoot !== null) {
    let write = knownTeamChoice(s, record);
    if (write === null && !s.flags.dryRun && interactive()) write = await confirm(TEAM_QUESTION);
    if (write !== null && !s.flags.dryRun) setTeamChoice(record, s.repoRoot, write);
    if (write === false) out("  note     team review section: not added (run init --yes without --no-repo to add it)");
    else {
      // Without --yes and a terminal, init stops before writing anyway.
      if (write === null && s.flags.dryRun) out("  note     team review section: init will ask whether to add it");
      teamActions.push(...planTeam(s, record));
      actions.push(...teamActions);
      printPlan(teamActions, []);
      if (teamActions.some((a) => a.apply)) {
        out("The review section init writes into the repo's CLAUDE.md and AGENTS.md:");
        for (const line of teamSection(s.version).split("\n")) out(`    ${line}`);
      }
    }
  }

  if (actions.some((a) => a.failed)) failed = true;
  const work = actions.filter((a) => a.apply !== undefined);

  if (s.flags.dryRun) {
    out(work.length === 0 ? "Nothing to change." : "Dry run: nothing was written.");
    return failed ? EXIT_TOOL_FAILED : EXIT_OK;
  }
  if (work.length === 0) {
    saveRecord(s.oqHome, record, recordBefore);
    out(s.flags.uninstall ? "Nothing to remove." : "Nothing to change: OpenQodex is already installed.");
    if (!s.flags.uninstall) closingRepoLines(s, rootConfig);
    return failed ? EXIT_TOOL_FAILED : EXIT_OK;
  }
  if (!s.flags.yes) {
    if (!interactive()) {
      process.stderr.write("openqodex init: no terminal to confirm in; run again with --yes\n");
      return EXIT_TOOL_FAILED;
    }
    if (!(await confirm(s.flags.uninstall ? "Remove these?" : "Write these files?"))) {
      out("Nothing was written.");
      return EXIT_OK;
    }
  }

  const failedPaths = new Set<string>();
  try {
    const brokenAgents = new Set<AgentId>();
    for (const a of work) {
      if (a.agent && brokenAgents.has(a.agent)) continue;
      try {
        if (a.guard && readText(a.guard.path) !== a.guard.before) {
          throw new Error(`changed while init was running, nothing written to ${a.guard.path}`);
        }
        await a.apply!();
      } catch (error) {
        process.stderr.write(`openqodex init: ${a.path}: ${message(error)}\n`);
        failed = true;
        failedPaths.add(a.path);
        // A hook must never point at a launcher that does not work.
        if (runtimeActions.has(a) && !s.flags.uninstall) return EXIT_TOOL_FAILED;
        if (a.agent) brokenAgents.add(a.agent);
      }
    }
  } finally {
    saveRecord(s.oqHome, record, recordBefore);
  }

  out();
  if (s.flags.uninstall) {
    out("OpenQodex was removed from the files above.");
    out(`Scanners stay in ${join(s.oqHome, "tools")}; delete that folder to remove them too.`);
    return failed ? EXIT_TOOL_FAILED : EXIT_OK;
  }

  if (s.repoRoot !== null) await startScannerInstalls(s.repoRoot);
  out(`OpenQodex is set up for ${s.agents.map((a) => AGENT_NAMES[a]).join(", ")}.`);
  out('Say this to your agent: "review my change with openqodex". Each agent\'s instructions now say to review in a separate subagent when a feature or fix is done.');
  if (s.agents.includes("codex")) out("Codex: run /hooks once inside Codex and trust the new OpenQodex hook, or Codex will not run it.");
  closingRepoLines(s, rootConfig);
  const teamChanged = teamActions.filter((a) => a.apply && !failedPaths.has(a.path)).map((a) => relative(s.repoRoot!, a.path));
  if (teamChanged.length > 0) {
    out(`Changed ${teamChanged.join(" and ")}: a review section your teammates' agents follow before they push.`);
    out(`Commit ${teamChanged.join(" and ")} so your team shares ${teamChanged.length > 1 ? "them" : "it"}.`);
  }
  if (s.repoRoot !== null && hookChoice === "pre-push") out("Every push from this repo now gets a scan through the git pre-push hook.");
  out(`To undo: npx openqodex init --uninstall${s.flags.project ? " --project" : ""}`);
  return failed ? EXIT_TOOL_FAILED : EXIT_OK;
}

// Names the two team files in the repo and what to do with them.
function closingRepoLines(s: Setup, rootConfig: boolean): void {
  if (s.repoRoot === null) return;
  const repoRoot = s.repoRoot;
  const files = [`${STATE_DIR}/${FOLDER_CONFIG}`, `${STATE_DIR}/${INSTRUCTIONS_FILE}`].filter((f) => repoStat(repoRoot, f) !== null);
  if (files.length > 0) out(`Commit ${files.join(" and ")} so your team shares ${files.length > 1 ? "them" : "it"}.`);
  if (files.includes(`${STATE_DIR}/${INSTRUCTIONS_FILE}`)) out(INSTRUCTIONS_LINE);
  if (rootConfig) out(ROOT_CONFIG_NOTE);
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseFlags(args);
  if (typeof parsed === "string") {
    process.stderr.write(`openqodex init: ${parsed}\n${USAGE}\n`);
    return EXIT_TOOL_FAILED;
  }
  const flags = parsed;
  const repoRoot = await repoRootOf(process.cwd());
  if (flags.project && repoRoot === null) {
    process.stderr.write("openqodex init --project: run it inside a git repository\n");
    return EXIT_TOOL_FAILED;
  }
  const home = homedir();
  let agents = flags.agents;
  if (agents.length === 0) agents = flags.uninstall ? [...AGENTS] : detectAgents(home);
  if (agents.length === 0) {
    process.stderr.write(
      "openqodex init: no coding agent found on this machine. Name one with --agent:\n" +
        AGENTS.map((a) => `  --agent ${a}    ${AGENT_NAMES[a]}\n`).join("") +
        "  --agent all\n",
    );
    return EXIT_TOOL_FAILED;
  }
  const setup: Setup = {
    flags,
    agents,
    scope: flags.project ? "project" : "user",
    home,
    oqHome: openqodexHomeDir(),
    repoRoot,
    version: __OPENQODEX_VERSION__,
  };
  try {
    // A dry run writes nothing and takes no lock. Otherwise everything runs
    // inside the commit boundary, so no update switches versions meanwhile.
    if (flags.dryRun) return await runLocked(setup);
    return await withBoundary(setup.oqHome, { wait: 60_000 }, async () => {
      removeOldLocks(setup.oqHome);
      const code = await runLocked(setup);
      if (!flags.uninstall) pruneRuntimes(setup.oqHome);
      return code;
    });
  } catch (error) {
    process.stderr.write(`openqodex init: ${message(error)}\n`);
    return EXIT_TOOL_FAILED;
  }
}
