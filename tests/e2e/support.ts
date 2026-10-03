import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candidate, Report } from "@openqodex/core";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const bin = join(root, "packages/cli/dist/bin.js");
export const toolsHome = process.env.OPENQODEX_E2E_HOME ?? join(tmpdir(), "openqodex-e2e-home");
const runs = join(root, "tests/e2e/runs");
mkdirSync(runs, { recursive: true });
const sessionFile = join(runs, `.session-${process.ppid}`);
if (!existsSync(sessionFile)) writeFileSync(sessionFile, new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-"));
export const receipt = join(runs, readFileSync(sessionFile, "utf8"));
mkdirSync(receipt, { recursive: true });

export type Result = { status: number | null; stdout: string; stderr: string; ms: number };
// Runs the built CLI (or, with shell, one command line through `sh -c`) with a
// temporary HOME and saves the command, exit code, time and output to the receipt.
export function run(label: string, cwd: string, args: string[], options: { home?: string; tools?: string; input?: string; timeout?: number; shell?: boolean } = {}): Result {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "oq-e2e-user-"));
  mkdirSync(home, { recursive: true });
  // OPENQODEX_AUTO_UPDATE=0: a command run through the launcher starts no update worker here.
  const env = { ...process.env, HOME: home, OPENQODEX_HOME: options.tools ?? toolsHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", OPENQODEX_AUTO_UPDATE: "0" };
  const command = options.shell ? "sh" : process.execPath;
  const argv = options.shell ? ["-c", args[0]!] : [bin, ...args];
  const started = Date.now();
  const p = spawnSync(command, argv, { cwd, env, encoding: "utf8", input: options.input, timeout: options.timeout ?? 300_000, maxBuffer: 16 * 1024 * 1024 });
  const out = { status: p.status, stdout: p.stdout ?? "", stderr: p.stderr ?? String(p.error ?? ""), ms: Date.now() - started };
  const dir = join(receipt, label.replace(/[^a-z0-9_-]/gi, "_"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "command.txt"), `${command} ${argv.join(" ")}\n`);
  writeFileSync(join(dir, "exit-code.txt"), `${out.status ?? "signal"}\n`);
  writeFileSync(join(dir, "duration-ms.txt"), `${out.ms}\n`);
  writeFileSync(join(dir, "stdout.txt"), out.stdout);
  writeFileSync(join(dir, "stderr.txt"), out.stderr);
  return out;
}
export function git(cwd: string, ...args: string[]): string {
  const p = spawnSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "oq-git-home-")), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (p.status !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout;
}
// The demo repo built by the product: baseline committed, planted change left uncommitted.
export function demo(label: string): string {
  const target = join(mkdtempSync(join(tmpdir(), "oq-demo-")), "repo");
  const p = run(`${label}-create`, root, ["demo", target, "--no-install", "--offline"]);
  if (p.status !== 0) throw new Error(p.stderr);
  return target;
}
export function baseline(): string {
  const dir = mkdtempSync(join(tmpdir(), "oq-clean-"));
  cpSync(join(root, "examples/demo-repo/baseline"), dir, { recursive: true });
  git(dir, "init", "-q"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "Baseline");
  return dir;
}
export function generatedSecret(dir: string): string {
  const secret = readFileSync(join(dir, "app/config.py"), "utf8").match(/sk_live_[A-Za-z0-9]{24}/)?.[0];
  if (secret === undefined) throw new Error("the demo repo has no generated secret");
  return secret;
}
export function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }
// The newest run's folder: the review receipt or the scan receipt, whichever
// was written last (a scan never writes the review receipt).
export function reportDir(dir: string): string {
  const receipts = [".openqodex/latest.json", ".openqodex/latest-scan.json"]
    .map((r) => join(dir, r))
    .filter((r) => existsSync(r))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (receipts.length === 0) throw new Error(`no run receipt in ${dir}/.openqodex`);
  return join(dir, readJson<{ dir: string }>(receipts[0]).dir);
}

// The repo's config: the first scan created .openqodex/config.yaml, which is
// read before a root .openqodex.yaml.
export function writeConfig(dir: string, text: string): void {
  mkdirSync(join(dir, ".openqodex"), { recursive: true });
  writeFileSync(join(dir, ".openqodex/config.yaml"), text);
}
export function report(dir: string): Report {
  return readJson<Report>(join(reportDir(dir), "report.json"));
}

// What `review --agent` left for the agent: the run folder, its candidates and change id.
export type Brief = { path: string; candidates: Candidate[]; changeId: string };
export function readBrief(dir: string): Brief {
  const path = reportDir(dir);
  return { path, candidates: readJson<Candidate[]>(join(path, "candidates.json")), changeId: readJson<{ change_id: string }>(join(path, "manifest.json")).change_id };
}
type Finding = { severity: string; category: string; confidence: number; file_path: string; line_number: number; title: string; description: string; suggested_change: null; source: string | null; candidate: string | null };
// An agent submission that raises the given candidates and drops the rest.
export function submission(changeId: string, candidates: Candidate[], raised: Candidate[]): { version: 1; change_id: string; summary: string; reviewer: "subagent"; findings: Finding[]; dropped: { candidate: string; reason: string }[] } {
  return {
    version: 1, change_id: changeId, summary: "Reviewed the planted change", reviewer: "subagent",
    findings: raised.map((c) => ({ severity: c.reviewSeverity, category: "security", confidence: 1, file_path: c.filePath, line_number: c.lineStart, title: c.ruleId, description: c.message, suggested_change: null, source: c.token, candidate: c.id })),
    dropped: candidates.filter((c) => !raised.includes(c)).map((c) => ({ candidate: c.id, reason: "Not actionable here" })),
  };
}

// Content hash of every file outside .git/ and .openqodex/ (every file when `all`).
export function inventory(dir: string, all = false): Record<string, string> {
  const found: Record<string, string> = {};
  function walk(at: string): void {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, e.name);
      const rel = relative(dir, path).replaceAll("\\", "/");
      if (!all && (rel === ".git" || rel === ".openqodex")) continue;
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) found[rel] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  walk(dir); return found;
}
// Path, size and modification time of every file: cheap enough for the 700 MB tools folder.
export function listing(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name); const s = statSync(path);
    found[relative(dir, path)] = `${s.size} ${s.mtimeMs}`;
  }
  return found;
}
// Everything in the repository a run could change that the developer would see:
// working-tree files, the index bytes and git status, read without refreshing the index.
export type Snapshot = { files: Record<string, string>; index: string; status: string; ignored: string };
export function snapshot(dir: string): Snapshot {
  const index = createHash("sha256").update(readFileSync(join(dir, ".git/index"))).digest("hex");
  return {
    files: inventory(dir), index,
    status: git(dir, "--no-optional-locks", "status", "--porcelain"),
    ignored: git(dir, "--no-optional-locks", "status", "--porcelain", "--ignored"),
  };
}
export function changedFiles(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]).sort();
}
export function offline(): boolean { return process.env.OPENQODEX_E2E_OFFLINE === "1"; }
export function skipNetwork(name: string): boolean {
  if (!offline()) return false;
  process.stdout.write(`${name}: skipped because OPENQODEX_E2E_OFFLINE=1\n`);
  return true;
}
export function printReceipt(): void { process.stdout.write(`Receipt: ${receipt}\n`); }
export function installed(): boolean { return existsSync(join(receipt, "doctor-install", "exit-code.txt")); }
