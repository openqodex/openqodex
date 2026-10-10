// Gitleaks adapter. Runs `gitleaks detect --no-git --source <dir>` over a
// staging copy of the changed files to find secret patterns (high-entropy
// strings plus a built-in rule pack covering common API keys and tokens).
// Output goes to a temp JSON file because gitleaks reserves stdout for its
// banner and progress when --report-path is omitted.
//
// The raw report holds every matched secret in clear text, so it lives in a
// temp folder outside the repo and is deleted in a `finally` whatever
// happens. The matched strings go back to the runner in memory only
// (`secrets`), so it can redact them from everything OpenQodex writes or
// prints; a finding's message is the rule description, never the secret.
//
// All secret findings are surfaced at "high" severity. Gitleaks
// doesn't emit a per-finding severity itself, and conservatively
// every regex / entropy hit is worth a human glance.

import fs from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "@openqodex/core";
import type { AdapterResult, ResolvedTool, StaticFinding } from "@openqodex/core";
import { describeFailure, execTool } from "../exec.js";
import type { Scratch } from "../scratch.js";
import type { Adapter } from "./index.js";
import { repoFileOrReason } from "./read.js";

const GITLEAKS_TIMEOUT_MS = 60_000;
const REPORT_MAX_BYTES = 8 * 1024 * 1024;

export type GitleaksRunArgs = {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  scratch: Scratch;
};

export async function runGitleaks(args: GitleaksRunArgs): Promise<AdapterResult> {
  if (args.changedPaths.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  let reportDir: string | null = null;
  let stagingDir: string | null = null;
  try {
    try {
      reportDir = await fs.mkdtemp(path.join(args.scratch.temp, "openqodex-gitleaks-"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { findings: [], error: `mkdtemp: ${message.slice(0, 200)}` };
    }
    const reportPath = path.join(reportDir, "report.json");

    // Scan a staging tree holding only the changed files rather than the
    // whole working tree: on a large monorepo a whole-tree scan cannot finish
    // inside its timeout, and findings are filtered to changed lines
    // downstream anyway, so the extra reach would buy no coverage.
    let staged: StagedTree;
    try {
      staged = await stageChangedFiles(args.repoDir, args.changedPaths, args.scratch.temp);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { findings: [], error: `stage: ${message.slice(0, 200)}` };
    }
    stagingDir = staged.dir;
    // Every changed path is a deletion or otherwise absent from the working
    // tree. Nothing to scan, and not an error.
    if (staged.fileCount === 0) return { findings: [], error: null };

    const cliArgs = [
      "detect",
      "--no-git",
      "--source",
      staged.dir,
      "--report-format",
      "json",
      "--report-path",
      reportPath,
      // Pointing --source at the staging tree loses gitleaks's implicit
      // discovery of a repo-level config, so a repository that has tuned
      // its rules would silently start seeing suppressed findings again.
      ...(staged.configPath ? ["--config", staged.configPath] : []),
      // exit 0 even when findings exist; we want the report, not a
      // status-code gate.
      "--exit-code",
      "0",
      // Quiet the progress banner; we don't read stdout.
      "--no-banner",
    ];

    const result = await execTool(args.tool.path, cliArgs, {
      cwd: staged.dir,
      timeoutMs: GITLEAKS_TIMEOUT_MS,
      maxBytes: 1024 * 1024,
      env: args.tool.env,
    });
    const failed = describeFailure("gitleaks", result, GITLEAKS_TIMEOUT_MS);
    if (failed) return { findings: [], error: failed.slice(0, 300) };
    if (result.exitCode !== 0) {
      return { findings: [], error: `gitleaks exit ${result.exitCode}: ${result.stderr.trim().slice(-200)}` };
    }

    let reportRaw: string;
    try {
      const stat = await fs.stat(reportPath).catch(() => null);
      // Gitleaks didn't produce a report. Could mean zero findings
      // on older versions that omit the file when empty, or a
      // silent failure. Treat as zero findings.
      if (!stat) return { findings: [], error: null };
      if (stat.size > REPORT_MAX_BYTES) {
        return { findings: [], error: `report too large (${stat.size}B), refusing to load` };
      }
      reportRaw = await fs.readFile(reportPath, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { findings: [], error: `read report: ${message.slice(0, 200)}` };
    }

    try {
      // Paths in the report are staging-tree absolute; stripping the
      // staging prefix is what puts them back in the repo-relative frame
      // the coverage filter matches against.
      const secrets = parseGitleaksSecrets(reportRaw);
      return { findings: parseGitleaksJson(reportRaw, staged.dir, secrets), error: null, secrets };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { findings: [], error: `parse: ${message.slice(0, 200)}` };
    }
  } finally {
    if (stagingDir) await removeDir(stagingDir);
    if (reportDir) await removeDir(reportDir);
  }
}

async function removeDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

export const gitleaks: Adapter = {
  source: "gitleaks",
  files: (changedPaths) => changedPaths,
  why: () => "any file",
  run: (args) => runGitleaks(args),
};

export type StagedTree = {
  dir: string;
  fileCount: number;
  // Absolute path to the repo's gitleaks config, when it has one.
  configPath: string | null;
};

// Config filenames gitleaks discovers implicitly when --source is the
// repo itself. Order matters only in that the first hit wins.
const GITLEAKS_CONFIG_NAMES = [".gitleaks.toml", "gitleaks.toml"];

/**
 * Mirror the changed files into a temp tree, preserving their
 * relative paths, so one gitleaks run covers exactly the change.
 *
 * Hardlinked rather than copied: the scan is read-only, so this costs a
 * directory entry per file instead of the bytes. Falls back to a copy when
 * link() refuses (cross-device, or a filesystem without hardlinks).
 *
 * Paths that do not exist in the working tree are skipped, not fatal: a
 * path list can include deletions and the old side of renames, neither of
 * which is present.
 */
export async function stageChangedFiles(
  repoDir: string,
  changedPaths: string[],
  tempRoot: string,
): Promise<StagedTree> {
  const dir = await fs.mkdtemp(path.join(tempRoot, "openqodex-gitleaks-src-"));
  let fileCount = 0;
  for (const rel of changedPaths) {
    // Never let a changed path escape the staging root. A "../" in a
    // changed path would otherwise write outside the temp tree.
    const normalized = path.normalize(rel);
    if (path.isAbsolute(normalized) || normalized.split(path.sep)[0] === "..") {
      continue;
    }
    const src = path.join(repoDir, normalized);
    const dest = path.join(dir, normalized);
    try {
      // Only a regular file inside the repo. A symlink at a changed path, or
      // a symlinked directory on the way, pointing at a file elsewhere on
      // the machine would otherwise get that target copied into the staging
      // tree, scanned, and any secret in it reported as a finding on the
      // link's own repo-relative path.
      const checked = await repoFileOrReason(repoDir, normalized, Number.MAX_SAFE_INTEGER);
      if ("reason" in checked) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try {
        await fs.link(src, dest);
      } catch {
        await fs.copyFile(src, dest);
      }
      fileCount += 1;
    } catch {
      // Absent from the working tree (deletion, rename source) or unreadable.
      continue;
    }
  }

  let configPath: string | null = null;
  for (const name of GITLEAKS_CONFIG_NAMES) {
    const candidate = path.join(repoDir, name);
    if (await fs.stat(candidate).then(() => true).catch(() => false)) {
      configPath = candidate;
      break;
    }
  }
  // .gitleaksignore is resolved relative to the scanned source, so it
  // has to travel with the staged files rather than be pointed at.
  const ignoreSrc = path.join(repoDir, ".gitleaksignore");
  try {
    await fs.copyFile(ignoreSrc, path.join(dir, ".gitleaksignore"));
  } catch {
    // No ignore file. Fine.
  }

  return { dir, fileCount, configPath };
}

type GitleaksReportEntry = {
  Description?: unknown;
  StartLine?: unknown;
  EndLine?: unknown;
  File?: unknown;
  RuleID?: unknown;
  Secret?: unknown;
};

// `secrets` are redacted from each message before it is trimmed, so a cut
// can never leave the first part of a secret behind.
export function parseGitleaksJson(json: string, repoDir: string, secrets: string[] = []): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const repoDirNormalized = repoDir.endsWith(path.sep)
    ? repoDir
    : repoDir + path.sep;
  const out: StaticFinding[] = [];
  for (const raw of parsed as GitleaksReportEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    const file = typeof raw.File === "string" ? raw.File : "";
    if (!file) continue;
    // Gitleaks emits absolute paths when --source is absolute. Strip
    // the source prefix so file_path is repo-relative and lines up
    // with DiffCoverage.
    const relPath = file.startsWith(repoDirNormalized)
      ? file.slice(repoDirNormalized.length)
      : file;
    const lineStart = numberOrZero(raw.StartLine);
    const lineEnd = Math.max(lineStart, numberOrZero(raw.EndLine) || lineStart);
    const ruleId = typeof raw.RuleID === "string" ? raw.RuleID : "secret";
    const description =
      typeof raw.Description === "string" ? raw.Description : "Potential secret";
    if (lineStart <= 0) continue;
    out.push({
      source: "gitleaks",
      ruleId,
      filePath: relPath,
      lineStart,
      lineEnd,
      severity: "high",
      message: trimMessage(redactSecrets(description, secrets)),
      reference: null,
    });
  }
  return out;
}

// The matched secret of every report entry, for in-memory redaction only.
export function parseGitleaksSecrets(json: string): string[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const raw of parsed as GitleaksReportEntry[]) {
    if (raw && typeof raw === "object" && typeof raw.Secret === "string" && raw.Secret) {
      out.push(raw.Secret);
    }
  }
  return out;
}

function numberOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return 0;
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
