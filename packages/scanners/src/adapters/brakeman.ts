// Brakeman adapter (Rails SAST). Runs `brakeman -q -f json
// --no-progress` in each Rails app the change touches and normalizes the vendor JSON
// `warnings[]` into StaticFinding[]. Brakeman is the only scanner in the
// ensemble that understands Rails: it follows SQL injection through
// ActiveRecord, cross-site scripting through views, mass assignment,
// unsafe redirects, command injection, and CSRF / auth gaps that a
// generic linter never sees.
//
// Brakeman is a whole-project scanner (no per-file invocation), so it runs
// only for a changed Rails-relevant file inside a Rails app: the nearest
// project folder holding the file has a Rails dependency in its Gemfile or
// Gemfile.lock and config/application.rb or bin/rails (detect.ts). It runs
// in that folder, wherever it sits in the repo, and its paths are rebased
// onto the repo root. A Gemfile and an app/ folder prove nothing: a React
// Native app with Expo Router has both. We anchor the warnings to changed
// lines downstream (the ensemble's filterToChangedLines), so a project-wide
// scan only ever surfaces hits on lines this change touched. It gets
// OpenQodex's own empty config, prints its report to stdout and writes
// nothing to disk.
//
// All errors are captured into the result; the runner never throws on a
// scanner failure: static analysis is additive context, not a gate.

import path from "node:path";
import type {
  AdapterResult,
  ResolvedTool,
  ScannerSeverity as StaticFindingSeverity,
  StaticFinding,
} from "@openqodex/core";
import { describeFailure, execTool, stderrTail } from "../exec.js";
import type { RepoFacts } from "../detect.js";
import type { Adapter } from "./index.js";
import { withOwnedConfig } from "./owned-config.js";
import type { Scratch } from "../scratch.js";
import { folderList } from "./words.js";

// Brakeman walks the whole app tree, so give it more headroom than the
// file-scoped scanners.
const BRAKEMAN_TIMEOUT_MS = 120_000;
const BRAKEMAN_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

// A Rails-relevant changed file: Ruby source, a view template (ERB /
// HAML / Slim can introduce XSS), or Gemfile / Rakefile / config.ru. A
// README or frontend-only change cannot introduce a Rails vuln Brakeman
// would surface, so it must not trigger the full-project scan.
function isRailsRelevantPath(p: string): boolean {
  return (
    /\.(rb|rake|gemspec|erb|haml|slim)$/i.test(p) ||
    /(^|\/)(Gemfile|Rakefile|config\.ru)$/i.test(p)
  );
}

// The changed Rails-relevant files inside a Rails app. A docs or frontend
// change in a Rails repo, and a Ruby file outside any Rails app, start no
// full-project scan.
function railsFiles(changedPaths: string[], facts: RepoFacts): string[] {
  return changedPaths.filter((p) => isRailsRelevantPath(p) && (facts.project(p)?.frameworks.includes("rails") ?? false));
}

// The Rails apps those files are in, by folder ("" is the repo root).
function railsApps(files: string[], facts: RepoFacts): string[] {
  return [...new Set(files.map((p) => facts.project(p)!.root))].sort();
}

// "Rails app in backend/", "Rails app at the repository root",
// "Rails apps in admin/ and backend/".
function railsWhy(files: string[], facts: RepoFacts): string {
  const apps = railsApps(files, facts);
  if (apps.length === 1 && apps[0] === "") return "Rails app at the repository root";
  return `Rails app${apps.length > 1 ? "s" : ""} in ${folderList(apps)}`;
}

export async function runBrakeman(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  facts: RepoFacts;
  scratch: Scratch;
}): Promise<AdapterResult> {
  const apps = railsApps(railsFiles(args.changedPaths, args.facts), args.facts);
  if (apps.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  const tool = args.tool;
  try {
    // -c <owned>: brakeman loads the first config it finds, and an explicit
    // one comes first, so the repo's config/brakeman.yml (which can name
    // output files, overwriting source with the report) is never read; the
    // report goes to stdout. Checked against the brakeman 6.2.1 source.
    // -q quiet, -f json the stable machine shape, --no-progress to keep
    // stdout pure JSON. No path arg: brakeman defaults to the cwd we set,
    // the app's folder. One app that fails keeps the others' findings.
    return await withOwnedConfig(args.scratch.temp, "brakeman.yml", "--- {}\n", async (configPath) => {
      const cliArgs = ["-c", configPath, "-q", "-f", "json", "--no-progress"];
      const findings: StaticFinding[] = [];
      const errors: string[] = [];
      for (const app of apps) {
        const where = app === "" ? "" : `${app}: `;
        try {
          const stdout = await execBrakeman(tool, cliArgs, path.join(args.repoDir, app));
          try {
            findings.push(...parseBrakemanJson(stdout, app));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`${where}parse: ${message.slice(0, 200)}`);
          }
        } catch (err) {
          errors.push(`${where}${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
        }
      }
      return { findings, error: errors.length > 0 ? errors.join("; ").slice(0, 300) : null };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }
}

async function execBrakeman(tool: ResolvedTool, cliArgs: string[], cwd: string): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs: BRAKEMAN_TIMEOUT_MS,
    maxBytes: BRAKEMAN_OUTPUT_MAX_BYTES,
    env: tool.env,
  });
  // Brakeman exit codes are messy: the default run exits 0 even
  // with warnings, but some versions / scan errors return
  // non-zero while STILL emitting the JSON report on stdout. So
  // prefer stdout whenever it's present and only treat a missing
  // binary or an empty-output failure as fatal.
  const failed = describeFailure("brakeman", result, BRAKEMAN_TIMEOUT_MS);
  if (result.failure === "not_found" && failed) throw new Error(failed);
  if (result.stdout.trim()) return result.stdout;
  if (failed) throw new Error(failed);
  if (result.exitCode !== null && result.exitCode !== 0) {
    throw new Error(`brakeman exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

export const brakeman: Adapter = {
  source: "brakeman",
  files: railsFiles,
  why: railsWhy,
  projects: railsApps,
  idle: (changedPaths) => (changedPaths.some(isRailsRelevantPath) ? "no Rails app holds a changed Ruby file" : null),
  run: (args) => runBrakeman(args),
};

type BrakemanWarning = {
  warning_type?: unknown;
  check_name?: unknown;
  message?: unknown;
  file?: unknown;
  line?: unknown;
  confidence?: unknown;
  code?: unknown;
  user_input?: unknown;
  link?: unknown;
};

// `app`: the folder brakeman ran in, put in front of each file it names
// (relative to that folder) so the path is the repo's.
export function parseBrakemanJson(json: string, app = ""): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as { warnings?: unknown };
  if (!parsed || !Array.isArray(parsed.warnings)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed.warnings as BrakemanWarning[]) {
    if (!raw || typeof raw !== "object") continue;
    const file = typeof raw.file === "string" ? raw.file : "";
    const filePath = file && app !== "" && !path.isAbsolute(file) ? path.posix.join(app, file) : file;
    const line = numberOrZero(raw.line);
    // check_name is the stable per-check id (e.g. "SQL",
    // "CrossSiteScripting"); warning_type is the human label.
    const ruleId = typeof raw.check_name === "string" && raw.check_name ? raw.check_name : "brakeman";
    // Warnings on the Gemfile / config without a line can't be anchored
    // to a changed diff line, so drop them like every other adapter.
    if (!filePath || line <= 0) continue;
    out.push({
      source: "brakeman",
      ruleId,
      filePath,
      lineStart: line,
      lineEnd: line,
      severity: confidenceToSeverity(raw.confidence),
      message: buildMessage(raw),
      reference: typeof raw.link === "string" && raw.link ? raw.link : null,
    });
  }
  return out;
}

// Brakeman warnings are always security findings; rank them by
// Brakeman's own confidence so the high-confidence injection /
// XSS hits sort above the speculative ones.
function confidenceToSeverity(raw: unknown): StaticFindingSeverity {
  if (typeof raw !== "string") return "medium";
  switch (raw.toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "weak":
      return "low";
    default:
      return "medium";
  }
}

// "<warning_type>: <message> [<short detail>]" where the detail is the
// flagged code snippet (or the user input it derived from). Gives the
// reviewer enough to locate the sink without dumping the whole node.
function buildMessage(raw: BrakemanWarning): string {
  const type = typeof raw.warning_type === "string" ? raw.warning_type : "";
  const body = typeof raw.message === "string" ? raw.message : "";
  const head = type && body ? `${type}: ${body}` : type || body;
  const detail =
    typeof raw.code === "string" && raw.code
      ? raw.code
      : typeof raw.user_input === "string" && raw.user_input
        ? raw.user_input
        : "";
  const full = detail ? `${head} [${detail}]` : head;
  return trimMessage(full);
}

function numberOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return 0;
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
