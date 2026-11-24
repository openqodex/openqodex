// `openqodex doctor [--install [--all-scanners [--require-all]]] [--json]`:
// what this machine has, what each scanner needs, which scanners this
// repository's files call for and why, and where OpenQodex keeps its files.
// Installs nothing unless --install is given, and then waits for every
// install: inside a repository the scanners its files call for (the
// selector a review uses, over every tracked and untracked file, less the
// config's excludes and disabled scanners); outside one, or with
// --all-scanners, every scanner this machine supports. --require-all, for
// an image build, then checks every scanner (checkScanners): each must be
// installed at its pinned version with its runtime and report its check
// case's finding; one stderr line per missing scanner, and exit 2.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { OpenQodexError, findRepoRoot, loadConfig } from "@openqodex/core";
import type { ToolStatus } from "@openqodex/core";
import { checkScanners, choiceLine, downloadsFor, installTools, openqodexHome, repoInventory, selectScanners, toolchainHash, toolsDir, toolStatuses, trustState } from "@openqodex/scanners";
import type { PreinstallResult, ScannerChoice } from "@openqodex/scanners";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { parseFlags } from "../flags.js";
import { progress } from "../pipeline.js";
import { claudeDriver, codexDriver, cursorDriver } from "@openqodex/review";
import type { ReviewerEntry } from "@openqodex/core";
import { listReadiness } from "../reviewers/list.js";
import { personalWebOff, projectFile, retiredReviewerWarning } from "../reviewers/settings.js";
import { readUserConfig, unknownKeysWarning } from "../user-config.js";
import { statusLines } from "./update.js";
import { telemetryStatus } from "../telemetry/dispatch.js";

const run$ = promisify(execFile);

async function gitVersion(): Promise<string | null> {
  try {
    const { stdout } = await run$("git", ["--version"]);
    return stdout.trim().replace(/^git version /, "");
  } catch {
    return null;
  }
}

type Report = {
  node: string;
  git: string | null;
  repo: string | null;
  config: string;
  scanners: ToolStatus[];
  // In a repository whose config loads: each scanner, whether its files call
  // for it, and why or why not, one line each.
  selection: { scanner: string; wanted: boolean; line: string }[] | null;
  // What --install installs here: the scanners the repository calls for
  // that download a tool, or null for every scanner.
  downloads: string[] | null;
  // sha256 of the pinned scanner table and its lock files: with
  // `downloads`, what a cache of the tools folder is keyed on.
  toolchain: string;
  custom: { name: string; source: string; trust: string }[];
  // In a repository whose config loads: the project's reviewer list, each
  // entry and whether it can start on this machine, and the web tools.
  // `entries` is null when the file lists none (auto).
  reviewers: { web: "on" | "off"; entries: (ReviewerEntry & { ready: boolean; line: string })[] | null } | null;
  home: string;
  settings: { file: string; values: Setting[]; warnings: string[] };
  update: string[];
  // Whether the anonymous usage data is on here, and the switch that decided.
  telemetry: { on: boolean; why: string };
  // With --require-all: every scanner checked after the install.
  required?: PreinstallResult;
};

type Setting = { key: string; value: string; source: string };

// Each key of the user config with the value in force and where it comes
// from: the environment, the file, or the default. The reviewer keys it held
// up to 0.23.0 are named in a warning: the project's file holds them now.
function userSettings(home: string, env: NodeJS.ProcessEnv, repo: string | null): Report["settings"] {
  const config = readUserConfig(home);
  const file = "config.yaml";
  const warnings: string[] = [];
  if (config.error !== null) warnings.push(`${config.error}: updates are off until it is fixed`);
  const unknown = unknownKeysWarning(config);
  if (unknown !== null) warnings.push(unknown);
  const retired = config.error === null ? retiredReviewerWarning(config, projectFile(repo)) : null;
  if (retired !== null) warnings.push(...retired.split("\n"));
  const v = config.values;
  const set = (value: unknown): boolean => value !== undefined && value !== null;
  const onOff = (value: unknown): "on" | "off" | null => (value === "on" || value === true ? "on" : value === "off" || value === false ? "off" : null);

  let update: Setting;
  if (env.CI !== undefined && env.CI !== "") update = { key: "update", value: "off", source: "CI is set" };
  else if (env.OPENQODEX_OFFLINE === "1") update = { key: "update", value: "off", source: "OPENQODEX_OFFLINE=1" };
  else if (env.OPENQODEX_AUTO_UPDATE === "0") update = { key: "update", value: "off", source: "OPENQODEX_AUTO_UPDATE=0" };
  else if (config.error !== null) update = { key: "update", value: "off", source: `${file} cannot be used` };
  else if (!set(v.update)) update = { key: "update", value: "on", source: "default" };
  else update = { key: "update", value: onOff(v.update) ?? "off", source: onOff(v.update) === null ? `${file}: ${String(v.update)} is neither on nor off` : file };

  const skip = !set(v.skip_version) ? { key: "skip_version", value: "none", source: "default" } : { key: "skip_version", value: String(v.skip_version), source: file };
  return { file: config.path, values: [update, skip], warnings };
}

const STATE_WORDS: Record<ToolStatus["state"], string> = {
  ready: "ready",
  will_install: "installs on first use",
  needs_runtime: "needs a runtime",
  installing: "installing",
  unsupported: "not available on this machine",
};

function text(r: Report): string {
  const width = Math.max(...r.scanners.map((s) => s.scanner.length), 10);
  const lines = [
    `Node        ${r.node}`,
    `git         ${r.git ?? "not found; install git"}`,
    `repository  ${r.repo ?? "not in a git repository"}`,
    `config      ${r.config}`,
    `home        ${r.home}`,
    "",
    "Scanners",
    ...r.scanners.map((s) => {
      const detail = s.detail ? `: ${s.detail}` : "";
      return `  ${s.scanner.padEnd(width)}  ${s.version.padEnd(10)}  ${STATE_WORDS[s.state]}${detail}`;
    }),
  ];
  if (r.selection !== null) {
    const needed = r.selection.filter((s) => s.wanted);
    const idle = r.selection.filter((s) => !s.wanted).map((s) => s.scanner);
    lines.push("", "This repository needs");
    for (const s of needed) lines.push(`  ${s.line}`);
    if (needed.length === 0) lines.push("  no scanner");
    if (idle.length > 0) lines.push(`Not needed here: ${idle.join(", ")}`);
  }
  if (r.custom.length > 0) {
    lines.push("", "Custom scanners");
    for (const c of r.custom) lines.push(`  ${c.name}  ${c.source}  ${c.trust}`);
  }
  if (r.reviewers !== null) {
    if (r.reviewers.entries === null) lines.push("", "Reviewers  none listed in the project's config: the agent you run the review from, then Claude Code, then Codex");
    else {
      lines.push("", "Reviewers  the project's list, tried top to bottom");
      r.reviewers.entries.forEach((e, i) => lines.push(`  ${i + 1}. ${[e.tool, ...(e.model !== undefined ? [`model ${e.model}`] : []), ...(e.effort !== undefined ? [`effort ${e.effort}`] : [])].join(", ")}: ${e.line}`));
    }
    lines.push(`  reviewer_web: ${r.reviewers.web}`);
  }
  lines.push("", `Your settings  ${r.settings.file}`);
  for (const s of r.settings.values) lines.push(`  ${s.key.padEnd(15)}  ${s.value} (${s.source})`);
  for (const w of r.settings.warnings) lines.push(`  ${w}`);
  lines.push("", "Updates", ...r.update.map((l) => `  ${l}`));
  lines.push("", `telemetry   ${r.telemetry.on ? "on" : `off (${r.telemetry.why})`}`);
  if (r.required) {
    const ready = r.required.tools.filter((t) => t.ok).length;
    lines.push("", "Required scanners", r.required.ok ? `  all ${ready} ready, each tool reported its check case` : `  ${ready} ready, ${r.required.missing.length} missing (listed on stderr)`);
  }
  const waiting = r.scanners.filter((s) => s.state === "will_install" && (r.downloads === null || r.downloads.includes(s.scanner)));
  if (waiting.length > 0) {
    lines.push(
      "",
      r.downloads === null
        ? "To install every scanner now: npx openqodex doctor --install"
        : "To install what this repository needs now: npx openqodex doctor --install",
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function run(args: string[]): Promise<number> {
  const { global, bools, values } = parseFlags(args, { bools: ["--install", "--all-scanners", "--json", "--require-all"] });
  if (bools.has("--install") && global.noInstall) {
    throw new OpenQodexError("--install cannot be used with --offline or --no-install");
  }
  if (bools.has("--all-scanners") && !bools.has("--install")) {
    throw new OpenQodexError("--all-scanners goes with --install");
  }
  if (bools.has("--require-all") && !(bools.has("--install") && bools.has("--all-scanners"))) {
    throw new OpenQodexError("--require-all goes with --install --all-scanners");
  }
  const git = await gitVersion();

  // A folder or config the developer named that does not work is an input
  // error: the table is still printed, and the exit code is 2.
  let inputError = false;
  let repo: string | null = null;
  if (values.has("--cwd") && !statSync(global.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    inputError = true;
  } else {
    try {
      repo = await findRepoRoot(global.cwd);
    } catch {
      // not in a repository is fine for doctor
    }
  }

  let configLine = inputError ? `folder not found: ${global.cwd}` : "no repository, defaults in use";
  const custom: Report["custom"] = [];
  let reviewers: Report["reviewers"] = null;
  let choices: ScannerChoice[] | null = null;
  if (repo !== null) {
    try {
      const loaded = loadConfig(repo, global.config, { runtimeVersion: __OPENQODEX_VERSION__ });
      choices = selectScanners({ repoDir: repo, paths: await repoInventory(repo, loaded.config), config: loaded.config });
      const n = loaded.config.custom.length;
      configLine = loaded.path === null ? "no config, defaults in use" : `ok, ${n} custom scanner${n === 1 ? "" : "s"}`;
      const listed = loaded.config.reviewers;
      const rows = listed === undefined ? null : await listReadiness(listed, [claudeDriver, codexDriver, cursorDriver], repo);
      reviewers = { web: loaded.config.reviewerWeb === false || personalWebOff(openqodexHome()) ? "off" : "on", entries: rows === null ? null : rows.map((row) => ({ ...row.entry, ready: row.version !== null, line: row.line })) };
      if (loaded.warnings.length > 0) configLine += ` (${loaded.warnings.join("; ")})`;
      for (const row of n > 0 ? trustState(repo, loaded.config) : []) {
        const trust =
          row.state === "trusted"
            ? "trusted"
            : row.state === "changed"
              ? "changed since approval; run openqodex trust"
              : "not approved; run openqodex trust";
        custom.push({ name: row.entry.name, source: row.entry.source, trust });
      }
    } catch (error) {
      configLine = (error as Error).message;
      inputError = true;
    }
  }

  // Outside a repository, or with --all-scanners: every scanner, as before.
  // A --cwd that does not exist, or a repository whose config does not load
  // (its scanners.disable is unknown), installs nothing.
  const downloads = inputError ? [] : bools.has("--all-scanners") || repo === null ? null : choices === null ? [] : downloadsFor(choices);
  if (bools.has("--install") && downloads === null && repo === null && !bools.has("--all-scanners")) {
    progress(global)("Not in a git repository: installing every scanner. Run it inside a repository to install only what that repository needs.");
  }
  const installed = bools.has("--install") ? await installTools(downloads, progress(global)) : null;
  const required = bools.has("--require-all") ? await checkScanners({ installRoot: toolsDir(openqodexHome()), require: "all", onProgress: progress(global) }) : null;
  // The table always lists every scanner.
  const statuses = await toolStatuses();
  const scanners = installed === null ? statuses : statuses.map((s) => installed.find((i) => i.scanner === s.scanner) ?? s);
  const report: Report = {
    node: process.versions.node,
    git,
    repo,
    config: configLine,
    scanners,
    selection: choices === null ? null : choices.map((c) => ({ scanner: c.scanner, wanted: c.wanted, line: choiceLine(c) })),
    downloads,
    toolchain: toolchainHash(),
    custom,
    reviewers,
    home: openqodexHome(),
    settings: userSettings(openqodexHome(), process.env, repo),
    update: statusLines(openqodexHome()),
    telemetry: telemetryStatus(args),
    ...(required ? { required } : {}),
  };
  process.stdout.write(bools.has("--json") ? `${JSON.stringify(report, null, 2)}\n` : text(report));
  for (const line of required?.missing ?? []) process.stderr.write(`openqodex: missing: ${line}\n`);
  return git === null || inputError || (required !== null && !required.ok) ? EXIT_TOOL_FAILED : EXIT_OK;
}
