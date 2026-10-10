// `openqodex init`: installs OpenQodex into the developer's coding agents in
// one step. User scope by default, so one install works in every repo and the
// agent files stay out of the repo's git status; `--project` writes them into
// the repo for a team to commit. Inside a repo the plan also holds the git
// pre-push hook, the two team files in `.openqodex/` and the team review
// section, each on by default (--hook none and --no-repo leave them out). For
// every agent the plan also registers the code graph's MCP server, on by
// default too (--no-mcp leaves it out). It prints the whole plan, for the
// developer and for the team, and asks once.
// It ends with a review (init-review.ts) unless --no-review is given.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { FOLDER_CONFIG, INSTRUCTIONS_FILE, STATE_DIR, loadConfig, repoStat } from "@openqodex/core";
import type { BuiltinScanner } from "@openqodex/core";
import { AGENT_NAMES, AGENTS, detectAgents, type AgentId } from "../agents/detect.js";
import { readText } from "../agents/files.js";
import { Guard } from "../agents/guarded-fs.js";
import { claudeHome, codexHome } from "../agents/homes.js";
import { excludeLine, gitDirs, gitPath, inWorkTree, planExclude, planUnexclude, repoRootOf } from "../agents/git.js";
import { planInstall, planMcpOff, planUninstall, type Action, type Ctx } from "../agents/plan.js";
import { withBoundary } from "../agents/lock.js";
import { loadRecord, saveRecord, serialize, type InstallRecord } from "../agents/record.js";
import { commitLines, INSTRUCTIONS_LINE, planRepoFiles, planRepoFilesRemoval, ROOT_CONFIG_NOTE } from "../agents/repo-folder.js";
import { clineCliData, targetsFor, teamSection, teamTargets, type Scope, type Target } from "../agents/targets.js";
import { runningContract } from "../contract.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { hostAgent } from "@openqodex/review";
import { launcherPath, launcherRunner, launcherUsers, oldLocks, openqodexHomeDir, planRuntime, planRuntimeRemoval, pruneRuntimes, removeOldLocks, staleRuntimes } from "../launcher.js";
import { planGitHook, planGitHookRemoval, setHookChoice } from "./hook.js";
import { firstReviewLine, reviewAfterInit } from "./init-review.js";
import { REVIEWER_LABELS, reviewerReadiness, type Readiness } from "../review-run.js";
import { pruneHomeReceipts, staleReceipts } from "../receipts.js";

type HookChoice = "pre-push" | "none";

// `mcp`: --mcp (true), --no-mcp (false), or neither (null).
type Flags = { agents: AgentId[]; project: boolean; yes: boolean; uninstall: boolean; dryRun: boolean; hook: HookChoice | null; noRepo: boolean; noReview: boolean; mcp: boolean | null };

const USAGE =
  "usage: openqodex init [--agent <claude-code|cursor|codex|cline|all>]... [--project] [--hook <pre-push|none>] [--no-repo] [--mcp | --no-mcp] [--no-review] [--yes] [--uninstall] [--dry-run]";

// The one question init asks, after the whole plan.
const WRITE_QUESTION = "Write these files?";

const HOST_NAMES: Record<NonNullable<ReturnType<typeof hostAgent>>, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

function parseFlags(args: string[]): Flags | string {
  const flags: Flags = { agents: [], project: false, yes: false, uninstall: false, dryRun: false, hook: null, noRepo: false, noReview: false, mcp: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project") flags.project = true;
    else if (arg === "--no-repo") flags.noRepo = true;
    else if (arg === "--no-review") flags.noReview = true;
    else if (arg === "--mcp") flags.mcp = true;
    else if (arg === "--no-mcp") flags.mcp = false;
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

// The agents to install into when detection found none; null when the
// developer cancels.
async function chooseAgents(): Promise<AgentId[] | null> {
  const prompts = await import("@clack/prompts");
  const answer = await prompts.multiselect<AgentId>({
    message: "No coding agent found on this machine. Which ones should OpenQodex install into?",
    options: AGENTS.map((a) => ({ value: a, label: AGENT_NAMES[a] })),
    required: true,
  });
  return prompts.isCancel(answer) ? null : AGENTS.filter((a) => answer.includes(a));
}

// Whether this repo gets the git pre-push hook: --hook, then the choice this
// repo made before, then yes. `earlier`: the choice came from the record.
function hookChoiceFor(s: Setup, record: InstallRecord): { hook: HookChoice; earlier: boolean } {
  if (s.flags.hook !== null) return { hook: s.flags.hook, earlier: false };
  const before = record.hookChoices.find((c) => c.repo === s.repoRoot);
  return before ? { hook: before.hook, earlier: true } : { hook: "pre-push", earlier: false };
}

// Whether this repo gets the team review section: --no-repo, then the
// choice this repo made before, then yes. --yes takes the defaults only for
// what was never answered: it never undoes a recorded --no-repo.
function teamChoiceFor(s: Setup, record: InstallRecord): { write: boolean; earlier: boolean } {
  if (s.flags.noRepo) return { write: false, earlier: false };
  const before = record.teamChoices.find((c) => c.repo === s.repoRoot);
  return before ? { write: before.write, earlier: true } : { write: true, earlier: false };
}

function setTeamChoice(record: InstallRecord, repo: string, write: boolean): void {
  record.teamChoices = record.teamChoices.filter((c) => c.repo !== repo);
  record.teamChoices.push({ repo, write });
}

// Where the --no-mcp choice of this run is recorded: this machine in user
// scope, the repository in project scope.
function mcpKey(s: Setup): string | null {
  return s.flags.project ? s.repoRoot : null;
}

// Whether the plan registers the code graph's MCP server: --mcp or --no-mcp,
// then a --no-mcp recorded here before, then yes. --yes never undoes a
// recorded --no-mcp. `earlier`: the choice came from the record.
function mcpChoiceFor(s: Setup, record: InstallRecord): { on: boolean; earlier: boolean } {
  if (s.flags.mcp !== null) return { on: s.flags.mcp, earlier: false };
  const off = record.mcpOff.some((c) => c.repo === mcpKey(s));
  return { on: !off, earlier: off };
}

// Records --no-mcp; --mcp takes it out, which is the default, on.
function setMcpChoice(record: InstallRecord, key: string | null, on: boolean): void {
  record.mcpOff = record.mcpOff.filter((c) => c.repo !== key);
  if (!on) record.mcpOff.push({ repo: key });
}

function isMcp(t: Target): t is Extract<Target, { kind: "mcp-json" | "mcp-toml" }> {
  return t.kind === "mcp-json" || t.kind === "mcp-toml";
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
  const ctx: Ctx = { record, scope: s.scope, repoRoot: s.repoRoot, guard: s.guard };
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

// The scanners this repo will need, with one line each saying why: the
// selector a review uses, over every tracked and untracked file as a review
// sees them, less the config's excludes and the scanners it switches off.
// The files init itself just wrote are not the developer's code and call
// for nothing.
async function scannerPlan(repoRoot: string, written: string[] = []): Promise<{ downloads: BuiltinScanner[]; lines: string[] }> {
  const { choiceLine, downloadsFor, repoInventory, selectScanners } = await import("@openqodex/scanners");
  const { config } = loadConfig(repoRoot, undefined, { runtimeVersion: __OPENQODEX_VERSION__ });
  const ours = new Set(written.map((p) => relative(repoRoot, p)));
  const paths = (await repoInventory(repoRoot, config)).filter((p) => !ours.has(p));
  const choices = selectScanners({ repoDir: repoRoot, paths, config });
  const downloads = downloadsFor(choices);
  return { downloads, lines: choices.filter((c) => downloads.includes(c.scanner)).map((c) => `  ${choiceLine(c)}`) };
}

// Starts the scanner installs this repo will need, outside any agent
// sandbox. The first review joins these downloads (init-review.ts). Never
// fails init: a review installs on first use anyway.
async function startScannerInstalls(repoRoot: string, written: string[]): Promise<void> {
  try {
    const { installToolsDetached } = await import("@openqodex/scanners");
    const plan = await scannerPlan(repoRoot, written);
    if (plan.downloads.length === 0) return;
    installToolsDetached(plan.downloads);
    out("Downloading the scanners this repo needs in the background:");
    for (const line of plan.lines) out(line);
  } catch (error) {
    process.stderr.write(`openqodex: could not start the scanner installs (${message(error)}); they install on first review instead\n`);
  }
}

// `init --dry-run`: the same lines, and nothing downloaded.
async function printScannerPlan(repoRoot: string): Promise<void> {
  try {
    const plan = await scannerPlan(repoRoot);
    if (plan.downloads.length === 0) {
      out("Scanners: none to download for this repo.");
      return;
    }
    out("Scanners init would download for this repo:");
    for (const line of plan.lines) out(line);
  } catch (error) {
    process.stderr.write(`openqodex: could not work out the scanners this repo needs (${message(error)})\n`);
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
  // Files this run wrote, so the closing review does not take init's own
  // files for the developer's change.
  written: string[];
  // Each written path's text before init wrote it, null when it was not there.
  before: Map<string, string | null>;
  // How the commands init prints start: the launcher by its full path, which
  // works with nothing on PATH, or in project scope the pinned npx form.
  runner: string;
  // The repository's git folders (none outside a repository): a file git
  // could stage lies outside them.
  gitFolders: string[];
  // Where init may write, and the repository whose links it never follows:
  // every write, rename and delete goes through it (guarded-fs.ts).
  guard: Guard;
};

// `mcpOn`: whether this run registers the code graph's MCP server.
function collectTargets(s: Setup, mcpOn: boolean): { targets: Target[]; notes: string[] } {
  const launcher = launcherPath(s.oqHome);
  const runner = s.flags.project ? `npx -y openqodex@${s.version}` : launcherRunner(launcher);
  // A removal plans the Cline CLI's MCP file whatever is there now, so one
  // init recorded is found and its record cleared even when the folder is gone.
  const clineCli = s.flags.uninstall || !mcpOn || existsSync(clineCliData(s.home));
  const targets: Target[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const agent of s.agents) {
    const r = targetsFor({ agent, scope: s.scope, home: s.home, repoRoot: s.repoRoot, version: s.version, runner, launcher, clineCli });
    notes.push(...r.skipped);
    if (mcpOn && !s.flags.uninstall) notes.push(...r.mcpNotes);
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

// Plans one agent's targets. A file that cannot be read, or a path through
// a link the repository holds, stops that agent with the reason. With
// `mcpOn` false, the MCP server registrations init recorded are removed.
async function planAgents(s: Setup, record: InstallRecord, targets: Target[], mcpOn: boolean): Promise<Action[]> {
  const ctx: Ctx = { record, scope: s.scope, repoRoot: s.repoRoot, guard: s.guard };
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
        } else if (!mcpOn && isMcp(t)) {
          const a = planMcpOff(t, ctx);
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
            const a = planUnexclude(excludeFile, line, s.repoRoot!, record, s.guard);
            if (a) planned.push(a);
          } else planned.push(planExclude(excludeFile, line, s.repoRoot!, record, s.guard));
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

// The section each agent's own instruction file gets, as it will be written.
function printSection(actions: Action[], targets: Target[]): void {
  const writes = new Set(actions.filter((a) => a.apply).map((a) => a.path));
  const sections = targets.flatMap((t) => (t.kind === "md-section" && writes.has(t.path) ? [t] : []));
  if (sections.length === 0) return;
  out(`The instruction section init writes into ${sections.map((t) => t.label).join(" and ")}:`);
  for (const line of sections[0].section.split("\n")) out(`    ${line}`);
}

// The install plan, every file under the one it is for: the developer, on
// this machine (user-scope agent files, the launcher, the git hook, which
// lives in this clone only), or the team, in the repo to commit.
function printInstallPlan(s: Setup, mine: Action[], team: Action[], notes: string[], targets: Target[], teamActions: Action[], hookChoice: HookChoice | null, mcpOn: boolean): void {
  out(`OpenQodex ${s.version} install plan (${s.scope} scope):`);
  if (mine.length > 0) {
    out("For you, on this machine:");
    printPlan(mine, []);
  }
  if (team.length > 0) {
    out("For the team, in this repo (commit these):");
    printPlan(team, []);
  }
  printPlan([], notes);
  printSection([...mine, ...team], targets);
  if (teamActions.some((a) => a.apply)) {
    out("The review section init writes into the repo's CLAUDE.md and AGENTS.md:");
    for (const line of teamSection(s.version).split("\n")) out(`    ${line}`);
  }
  // The opt-outs of what this plan adds by default.
  const optOuts = [
    ...(hookChoice === "pre-push" ? ["To leave out the git pre-push hook: --hook none."] : []),
    ...(teamActions.length > 0 ? ["To leave out the team review section: --no-repo."] : []),
    ...(mcpOn && targets.some(isMcp) ? ["To leave out the code graph's MCP server for your agents: --no-mcp."] : []),
  ];
  if (optOuts.length > 0) out(optOuts.join(" "));
}

// How the install step ended, beside its exit code. Only "written" and
// "unchanged" go on to the review: a declined plan ("cancelled") stops there,
// and so does a run with nothing to write and no consent ("unconfirmed").
type Outcome = { code: number; ended: "written" | "unchanged" | "unconfirmed" | "cancelled" | "stopped" | "dry-run" | "removed" };

async function runLocked(s: Setup): Promise<Outcome> {
  const record = loadRecord(s.oqHome);
  const recordBefore = serialize(record);
  const mcp = mcpChoiceFor(s, record);
  const { targets, notes } = collectTargets(s, mcp.on);
  if (!s.flags.uninstall && s.agents.includes("cursor") && s.repoRoot !== null) {
    notes.push("Cursor has no global instruction file: its rule in this repo carries the review instructions");
  }
  const actions: Action[] = [];
  const runtimeActions = new Set<Action>();
  // The install plan by whom each file is for (printInstallPlan).
  const mine: Action[] = [];
  const team: Action[] = [];
  const teamActions: Action[] = [];
  let failed = false;

  const agentActions = await planAgents(s, record, targets, mcp.on);
  let rootConfig = false;
  let hookChoice: HookChoice | null = null;
  // The git pre-push hook action, when the plan holds one.
  let gitHook: Action | null = null;
  if (s.flags.uninstall) {
    actions.push(...agentActions);
    record.mcpOff = record.mcpOff.filter((c) => c.repo !== mcpKey(s));
    if (s.repoRoot !== null) {
      actions.push(...(await planRepoFilesRemoval(s.repoRoot, record, s.guard)));
      const hook = await planGitHookRemoval(s.repoRoot, record, s.oqHome, s.guard);
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
    const runtime = needsLauncher ? planRuntime(record, s.version, s.oqHome, s.guard) : [];
    for (const a of runtime) runtimeActions.add(a);
    mine.push(...runtime);
    // Project-scope agent files are committed: the team's.
    (s.flags.project ? team : mine).push(...agentActions);
    if (!s.flags.dryRun && s.flags.mcp !== null) setMcpChoice(record, mcpKey(s), s.flags.mcp);
    if (!mcp.on) notes.push(`the code graph's MCP server: left out${mcp.earlier ? ", as chosen before" : ""} (--no-mcp); --mcp adds it`);
    if (s.repoRoot !== null) {
      const repo = planRepoFiles(s.repoRoot, record, s.guard);
      rootConfig = repo.rootConfig;
      team.push(...repo.actions);
      const hook = hookChoiceFor(s, record);
      hookChoice = hook.hook;
      if (!s.flags.dryRun) setHookChoice(record, s.repoRoot, hookChoice);
      if (hookChoice === "pre-push") {
        if (runtimeActions.size === 0) {
          const more = planRuntime(record, s.version, s.oqHome, s.guard);
          for (const a of more) runtimeActions.add(a);
          // The runtime goes first: the hook calls it.
          mine.unshift(...more);
        }
        gitHook = (await planGitHook(s.repoRoot, record, s.oqHome, false, s.guard)).action;
        mine.push(gitHook);
      } else notes.push(`git pre-push hook: left out${hook.earlier ? ", as this repo chose before" : ""}; --hook pre-push adds it`);
      // Project scope writes its own section into the same two files.
      if (!s.flags.project) {
        const choice = teamChoiceFor(s, record);
        if (!s.flags.dryRun) setTeamChoice(record, s.repoRoot, choice.write);
        if (choice.write) {
          teamActions.push(...planTeam(s, record));
          team.push(...teamActions);
        } else notes.push(choice.earlier ? "team review section: left out, as this repo chose before (--no-repo)" : "team review section: left out (--no-repo), and recorded for this repo");
      }
    }
    actions.push(...mine, ...team);
    if ([...runtimeActions].some((a) => a.failed)) {
      printInstallPlan(s, mine, team, notes, targets, teamActions, hookChoice, mcp.on);
      process.stderr.write("openqodex init: nothing was written; the launcher hooks call cannot be set up (see above)\n");
      return { code: EXIT_TOOL_FAILED, ended: "stopped" };
    }
  }

  if (s.flags.uninstall && !s.flags.project) {
    // Hook files this run leaves alone (another agent, a file that could not
    // be parsed) still call the launcher.
    const touched = new Set(actions.filter((a) => a.apply).map((a) => a.path));
    const willStay = launcherUsers(record).filter((p) => !touched.has(p));
    actions.push(...planRuntimeRemoval(record, s.oqHome, willStay, s.guard));
  }

  if (s.flags.uninstall) {
    out("OpenQodex uninstall plan:");
    printPlan(actions, notes);
  } else printInstallPlan(s, mine, team, notes, targets, teamActions, hookChoice, mcp.on);

  if (actions.some((a) => a.failed)) failed = true;
  const work = actions.filter((a) => a.apply !== undefined);

  if (s.flags.dryRun) {
    if (!s.flags.uninstall && s.repoRoot !== null) await printScannerPlan(s.repoRoot);
    out(work.length === 0 ? "Nothing to change." : "Dry run: nothing was written.");
    return { code: failed ? EXIT_TOOL_FAILED : EXIT_OK, ended: "dry-run" };
  }
  // One consent for the whole run, settled before anything is written, the
  // record included, and before the review: --yes; else a terminal, where
  // the plan is asked about when it writes files; else the agent this runs
  // inside; else none.
  //
  // A host marker (CLAUDECODE, CODEX_THREAD_ID, CURSOR_AGENT) counts as
  // consent because it grants nothing --yes does not: whoever can run init
  // in that shell can pass --yes. It only spares an agent's shell, which has
  // no terminal, the exit 2. Decided 2026-10-07; uninstall still needs --yes.
  const host = hostAgent();
  const consent = s.flags.yes ? "yes" : interactive() ? "terminal" : host !== null && !s.flags.uninstall ? "agent" : "none";
  if (work.length === 0) {
    // Nothing to write in the agents' files; the record may still change (a
    // choice, an entry found in place), and the housekeeping in
    // ~/.openqodex may have something to remove. Without consent neither
    // happens. In a terminal either is asked about, as any write is.
    const recordChanges = serialize(record) !== recordBefore;
    const housekeeping = oldLocks(s.oqHome).length + staleRuntimes(s.oqHome).length + staleReceipts(s.oqHome).length > 0;
    if (consent === "terminal" && (recordChanges || housekeeping)) {
      out(
        `No file of your agents changes. init would ${[...(recordChanges ? ["record the choices above"] : []), ...(housekeeping ? ["remove old runtimes, receipts or lock files from ~/.openqodex"] : [])].join(" and ")}.`,
      );
      if (!(await confirm(WRITE_QUESTION))) {
        out("Nothing was written.");
        return { code: EXIT_OK, ended: "cancelled" };
      }
    }
    if (consent !== "none") saveRecord(s.oqHome, record, recordBefore, s.guard);
    out(s.flags.uninstall ? "Nothing to remove." : "Nothing to change: OpenQodex is already installed.");
    if (!s.flags.uninstall) {
      closingRepoLines(s, rootConfig);
      out(`To undo: ${undoCommand(s)}`);
    }
    const ended = consent === "none" ? "unconfirmed" : s.flags.uninstall ? "removed" : "unchanged";
    return { code: failed ? EXIT_TOOL_FAILED : EXIT_OK, ended };
  }
  if (consent !== "yes") {
    if (consent === "terminal") {
      if (!(await confirm(s.flags.uninstall ? "Remove these?" : WRITE_QUESTION))) {
        out("Nothing was written.");
        return { code: EXIT_OK, ended: "cancelled" };
      }
    } else if (consent === "agent" && host !== null) {
      out(`Running inside ${HOST_NAMES[host]} with no terminal to ask in: writing the plan above.`);
    } else {
      process.stderr.write(
        s.flags.uninstall
          ? "openqodex init: no terminal to confirm in; run again with --yes\n"
          : "openqodex init: no terminal to confirm in, and no agent to act for; nothing was written.\n" +
              "Run it again with --yes to write the plan above. To change the plan: --hook none (no git pre-push hook), --no-repo (no team review section), --no-mcp (no code graph MCP server), --project (the agent files inside the repo, for the team to commit), --agent <name> (only that agent).\n",
      );
      return { code: EXIT_TOOL_FAILED, ended: "stopped" };
    }
  }

  const failedPaths = new Set<string>();
  // The files below are written under this version's agent contract.
  if (!s.flags.uninstall) record.agentContract = runningContract().agent;
  // Only a file git could stage is part of the change: never one in the git
  // folder (the pre-push hook, the exclude file), wherever that folder is.
  const gitFolders = s.gitFolders;
  try {
    const brokenAgents = new Set<AgentId>();
    for (const a of work) {
      if (a.agent && brokenAgents.has(a.agent)) continue;
      try {
        if (a.guard && readText(a.guard.path) !== a.guard.before) {
          throw new Error(`changed while init was running, nothing written to ${a.guard.path}`);
        }
        // Every action writes through s.guard, which walks its path again
        // when it writes: a link the repository put in place after the plan
        // is refused there.
        // The text before init's first write, so the review after init
        // takes the developer's own edits and not init's.
        if (s.repoRoot !== null && !s.before.has(a.path) && inWorkTree(s.repoRoot, gitFolders, a.path)) {
          try {
            s.before.set(a.path, readText(a.path));
          } catch {
            // not a text file: the review takes it as it is on disk
          }
        }
        await a.apply!();
        s.written.push(a.path);
      } catch (error) {
        process.stderr.write(`openqodex init: ${a.path}: ${message(error)}\n`);
        failed = true;
        failedPaths.add(a.path);
        // A hook must never point at a launcher that does not work.
        if (runtimeActions.has(a) && !s.flags.uninstall) return { code: EXIT_TOOL_FAILED, ended: "stopped" };
        if (a.agent) brokenAgents.add(a.agent);
      }
    }
  } finally {
    saveRecord(s.oqHome, record, recordBefore, s.guard);
  }

  out();
  if (s.flags.uninstall) {
    out("OpenQodex was removed from the files above.");
    out(`Scanners stay in ${join(s.oqHome, "tools")}; delete that folder to remove them too.`);
    return { code: failed ? EXIT_TOOL_FAILED : EXIT_OK, ended: "removed" };
  }

  if (s.repoRoot !== null) await startScannerInstalls(s.repoRoot, s.written);
  out(`OpenQodex ${s.version} is installed for ${s.agents.map((a) => AGENT_NAMES[a]).join(", ")}.`);
  // What was written, by whom it is for, as the plan grouped it.
  const written = (list: Action[]): string[] => [...new Set(list.filter((a) => a.apply && !failedPaths.has(a.path)).map((a) => shown(s, a.path)))];
  const forYou = written(mine);
  if (forYou.length > 0) {
    out("Written for you, on this machine only:");
    for (const p of forYou) out(`  ${p}`);
    out(`  To undo: ${undoCommand(s)}`);
  }
  // Every push is checked only when the OpenQodex hook is in place: written
  // now or found as written. Husky, lefthook or a hook of the developer's
  // own gets nothing, and the plan's note says what to add there.
  if (gitHook !== null) {
    const inPlace = gitHook.verb === "skip" || (gitHook.apply !== undefined && !failedPaths.has(gitHook.path));
    if (inPlace) out("Every push from this repo is now checked for a review through the git pre-push hook.");
    else out(`The git pre-push hook is not set up: ${gitHook.note.replace(/^git pre-push hook: /, "")}.`);
  }
  const forTeam = written(team);
  if (forTeam.length > 0) {
    out("Written for the team, in this repo:");
    for (const p of forTeam) out(`  ${p}`);
    const teamChanged = teamActions.filter((a) => a.apply && !failedPaths.has(a.path)).map((a) => relative(s.repoRoot!, a.path));
    closingRepoLines(s, rootConfig, "  ", teamChanged);
  }
  if (forYou.length === 0) out(`To undo: ${undoCommand(s)}`);
  // --project moves the agent files only: the scanners, init's record and the
  // launcher a git hook needs stay on this machine.
  if (s.repoRoot !== null && !s.flags.project) {
    out(`To put the agent files in this repo instead, for the team to commit: ${s.runner} init --project (the scanners and init's record stay in ~/.openqodex)`);
  }
  // An agent reads its MCP servers when it starts.
  const mcpPaths = new Set(targets.filter(isMcp).map((t) => t.path));
  const mcpWritten = mcp.on ? [...new Set(agentActions.filter((a) => a.agent && mcpPaths.has(a.path) && s.written.includes(a.path)).map((a) => AGENT_NAMES[a.agent!]))] : [];
  if (mcpWritten.length > 0) out(`Restart ${mcpWritten.join(", ")} to load the code graph's MCP server.`);
  if (s.agents.includes("codex")) out("Codex: run /hooks once inside Codex and trust the new OpenQodex hook, or Codex will not run it.");
  return { code: failed ? EXIT_TOOL_FAILED : EXIT_OK, ended: "written" };
}

// A path as the closing lines show it: inside the repo relative to it,
// inside the home folder from ~, anything else as it is.
function shown(s: Setup, path: string): string {
  if (s.repoRoot !== null) {
    const r = relative(s.repoRoot, path);
    if (r !== "" && !r.startsWith("..") && !isAbsolute(r)) return r;
  }
  const h = relative(s.home, path);
  return h !== "" && !h.startsWith("..") && !isAbsolute(h) ? `~/${h}` : path;
}

// The command that removes this install, written for the runner that works
// on this machine: the launcher, or in project scope the pinned npx form.
function undoCommand(s: Setup): string {
  return `${s.runner} init --uninstall${s.flags.project ? " --project" : ""}`;
}

// Runs every reviewer's detect() at once and says which one a review would
// start, or why none can and what fixes each. True when one can start.
async function reviewerCheck(s: Setup): Promise<boolean> {
  out();
  let found: Readiness;
  try {
    found = await reviewerReadiness(s.repoRoot ?? process.cwd());
  } catch (error) {
    process.stderr.write(`openqodex: ${message(error)}\n`);
    return false;
  }
  if (found.ready !== null) {
    out(`Reviewer ready: ${REVIEWER_LABELS[found.ready.name] ?? found.ready.name} ${found.ready.version}, installed and logged in. Each review starts it as a separate process.`);
    return true;
  }
  out("No reviewer can start yet. A review needs Claude Code or Codex, installed and logged in. Fix one of these:");
  for (const line of found.reasons) out(`  - ${line}`);
  out(`Until then, the agent you are in can review the change itself: ${s.runner} review --agent`);
  return false;
}

// Names the two team files in the repo, and `also` (the files that got the
// team review section), and what to do with them.
function closingRepoLines(s: Setup, rootConfig: boolean, indent = "", also: string[] = []): void {
  if (s.repoRoot === null) return;
  const repoRoot = s.repoRoot;
  const files = [`${STATE_DIR}/${FOLDER_CONFIG}`, `${STATE_DIR}/${INSTRUCTIONS_FILE}`].filter((f) => repoStat(repoRoot, f) !== null);
  for (const line of commitLines(repoRoot, [...files, ...also])) out(`${indent}${line}`);
  if (files.includes(`${STATE_DIR}/${INSTRUCTIONS_FILE}`)) out(`${indent}${INSTRUCTIONS_LINE}`);
  if (rootConfig) out(`${indent}${ROOT_CONFIG_NOTE}`);
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
  // None found: a terminal can ask which ones (an agent installed where no
  // check looks, or one about to be installed); a shell without one gets the list.
  if (agents.length === 0 && interactive() && !flags.yes && !flags.dryRun) {
    const chosen = await chooseAgents();
    if (chosen === null) {
      out("Nothing was written.");
      return EXIT_OK;
    }
    agents = chosen;
  }
  if (agents.length === 0) {
    process.stderr.write(
      "openqodex init: no coding agent found on this machine. Name one with --agent:\n" +
        AGENTS.map((a) => `  --agent ${a}    ${AGENT_NAMES[a]}\n`).join("") +
        "  --agent all\n",
    );
    return EXIT_TOOL_FAILED;
  }
  const gitFolders = repoRoot !== null ? await gitDirs(repoRoot) : [];
  const setup: Setup = {
    flags,
    agents,
    scope: flags.project ? "project" : "user",
    home,
    oqHome: openqodexHomeDir(),
    repoRoot,
    version: __OPENQODEX_VERSION__,
    written: [],
    before: new Map(),
    runner: flags.project ? `npx -y openqodex@${__OPENQODEX_VERSION__}` : launcherRunner(launcherPath(openqodexHomeDir())),
    gitFolders,
    // Every folder this run may write, each opened once, here.
    guard: new Guard({ repoRoot, gitFolders, roots: [home, claudeHome(home), codexHome(home), openqodexHomeDir()] }),
  };
  try {
    // A dry run writes nothing and takes no lock. Otherwise everything runs
    // inside the commit boundary, so no update switches versions meanwhile.
    if (flags.dryRun) return (await runLocked(setup)).code;
    const outcome = await withBoundary(setup.oqHome, { wait: 60_000 }, async () => {
      const outcome = await runLocked(setup);
      // The housekeeping in ~/.openqodex runs only on a run the developer
      // agreed to: never on a declined, stopped or unconfirmed one.
      if (outcome.ended === "written" || outcome.ended === "unchanged" || outcome.ended === "removed") {
        removeOldLocks(setup.oqHome, setup.guard);
        if (!flags.uninstall) pruneRuntimes(setup.oqHome, Date.now(), setup.guard);
        pruneHomeReceipts(setup.oqHome, Date.now(), setup.guard);
      }
      return outcome;
    });
    // After the boundary is released, so the review holds no install lock.
    // A declined or stopped install reviews nothing.
    const installed = outcome.ended === "written" || outcome.ended === "unchanged";
    if (outcome.code === EXIT_OK && installed) {
      // Whether a reviewer can start, checked whatever comes next, so "set up"
      // never hides a review that cannot run.
      const ready = await reviewerCheck(setup);
      if (flags.noReview) firstReviewLine("skipped", "--no-review");
      else if (repoRoot === null) firstReviewLine("skipped", "not inside a git repository");
      else if (!ready) firstReviewLine("unavailable");
      else await reviewAfterInit({ repoRoot, runner: setup.runner, interactive: interactive() && !flags.yes, initFiles: setup.before });
      // The command to run next, by the launcher's full path: an npx install
      // puts no `openqodex` on PATH, and init never edits a shell profile.
      out();
      out(`Next: say "review my change with openqodex" to your agent, or run ${setup.runner} review`);
    } else if (outcome.ended === "unconfirmed") {
      firstReviewLine("skipped", "no terminal to confirm in, and no agent to act for; run init with --yes");
    }
    return outcome.code;
  } catch (error) {
    process.stderr.write(`openqodex init: ${message(error)}\n`);
    return EXIT_TOOL_FAILED;
  }
}
