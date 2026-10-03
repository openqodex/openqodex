// `openqodex doctor [--install] [--json]`: what this machine has, what each
// scanner needs, and where OpenQodex keeps its files. Installs nothing unless
// --install is given, and then waits for every install.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { OpenQodexError, findRepoRoot, loadConfig } from "@openqodex/core";
import type { ToolStatus } from "@openqodex/core";
import { installTools, openqodexHome, toolStatuses, trustState } from "@openqodex/scanners";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { parseFlags } from "../flags.js";
import { progress } from "../pipeline.js";
import { statusLines } from "./update.js";

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
  custom: { name: string; source: string; trust: string }[];
  home: string;
  update: string[];
};

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
  if (r.custom.length > 0) {
    lines.push("", "Custom scanners");
    for (const c of r.custom) lines.push(`  ${c.name}  ${c.source}  ${c.trust}`);
  }
  lines.push("", "Updates", ...r.update.map((l) => `  ${l}`));
  if (r.scanners.some((s) => s.state === "will_install")) {
    lines.push("", "To install every scanner now: npx openqodex doctor --install");
  }
  return `${lines.join("\n")}\n`;
}

export async function run(args: string[]): Promise<number> {
  const { global, bools, values } = parseFlags(args, { bools: ["--install", "--json"] });
  if (bools.has("--install") && global.noInstall) {
    throw new OpenQodexError("--install cannot be used with --offline or --no-install");
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
  if (repo !== null) {
    try {
      const loaded = loadConfig(repo, global.config);
      const n = loaded.config.custom.length;
      configLine = loaded.path === null ? "no config, defaults in use" : `ok, ${n} custom scanner${n === 1 ? "" : "s"}`;
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

  const scanners = bools.has("--install") ? await installTools(null, progress(global)) : await toolStatuses();
  const report: Report = {
    node: process.versions.node,
    git,
    repo,
    config: configLine,
    scanners,
    custom,
    home: openqodexHome(),
    update: statusLines(openqodexHome()),
  };
  process.stdout.write(bools.has("--json") ? `${JSON.stringify(report, null, 2)}\n` : text(report));
  return git === null || inputError ? EXIT_TOOL_FAILED : EXIT_OK;
}
