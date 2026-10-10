// Records the real built CLI. Only the two model provider programs are stand-ins.
//
// The review runs with --skip semgrep,osv-scanner. Those two read live data
// on every run: semgrep fetches its rule packs from the Semgrep registry and
// osv-scanner looks the lockfile's packages up at osv.dev. A new rule or a
// new advisory would change the recording with no change to this code. Every
// other scanner the demo calls for answers from its pinned binary alone
// (trivy skips its check update; kubeconform reads schemas at one pinned
// commit), so the recording holds only their candidates. The end-to-end
// suite still runs semgrep and osv-scanner live on the demo.
import { spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fixDemoSecret } from "./fixture-secret.mjs";
import { normalize, normalizedLastReview, normalizedSnapshotHash, sha256 } from "./normalize.mjs";

export const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
export const bin = join(root, "packages/cli/dist/bin.js");
export const drivers = ["claude", "codex"];
// The scanners that read live data, left out of the recording (see the top).
export const SKIPPED = "semgrep,osv-scanner";
const required = ["manifest.json", "scan.json", "brief.md", "impact.json", "report.md", "report.json", "report.sarif", "submission.json", "trace.json", "report.html"];

function command(program, args, cwd, env) {
  return new Promise((done, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (part) => { stdout += part; });
    child.stderr.setEncoding("utf8").on("data", (part) => { stderr += part; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) reject(new Error(`${program} stopped by ${signal}`));
      else done({ code, stdout, stderr });
    });
  });
}

export async function checked(program, args, cwd, env) {
  const result = await command(program, args, cwd, env);
  if (result.code !== 0) throw new Error(`${program} ${args.join(" ")} exited ${result.code}: ${result.stderr}`);
  return result;
}

export async function prepare() {
  const scratch = realpathSync(tmpdir());
  if (scratch === root || scratch.startsWith(root + sep)) throw new Error("TMPDIR must be outside the repository");
  if (process.versions.node.split(".")[0] !== "22") throw new Error("golden runs require Node 22");
  const work = mkdtempSync(join(scratch, "oq-golden-record-"));
  const home = join(work, "home");
  const demo = join(work, "demo");
  const user = join(work, "user");
  const temp = join(work, "tmp");
  for (const path of [home, user, temp]) mkdirSync(path);
  const env = { ...process.env, HOME: user, OPENQODEX_HOME: home, TMPDIR: temp, OPENQODEX_AUTO_UPDATE: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", UV_CACHE_DIR: join(work, "uv-cache"), XDG_CACHE_HOME: join(work, "cache") };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") && !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].includes(key)) delete env[key];
  }
  for (const key of ["CLAUDECODE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CODEX_SANDBOX", "CODEX_THREAD_ID", "OPENQODEX_REVIEW_DEPTH", "OPENQODEX_OFFLINE"]) delete env[key];
  try {
    console.log("golden: building CLI");
    await checked("pnpm", ["build"], root, env);
    await checked(process.execPath, [bin, "demo", demo, "--no-install", "--offline", "--no-color"], root, env);
    // The planted change stays uncommitted and unstaged, as the demo command
    // leaves it and the end-to-end tests review it.
    const fixed = fixDemoSecret(demo);
    console.log(`golden: fixed synthetic secret in ${fixed.files.length} files, ${fixed.replacements} replacements`);
    const started = Date.now();
    console.log("golden: installing demo scanners with doctor --install");
    const doctor = await checked(process.execPath, [bin, "doctor", "--install", "--json"], demo, env);
    const installMs = Date.now() - started;
    console.log(`golden: doctor --install exited 0 in ${installMs} ms`);
    const status = JSON.parse(doctor.stdout);
    const missing = status.scanners.filter((s) => status.selection.some((c) => c.scanner === s.scanner && c.wanted) && s.state !== "ready");
    if (missing.length) throw new Error(`doctor did not install required scanners: ${JSON.stringify(missing)}`);
    return { work, home, demo, env, installMs };
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
}

export async function capture(prepared, destination) {
  const { work, home, demo, env } = prepared;
  const repoId = sha256(realpathSync(demo));
  for (const driver of drivers) {
    const provider = join(work, `provider-${driver}`);
    mkdirSync(provider);
    const source = join(here, "stand-ins", `${driver}.cjs`);
    const executable = join(provider, driver);
    writeFileSync(executable, `#!${process.execPath}\n${readFileSync(source, "utf8")}`);
    chmodSync(executable, 0o755);
    cpSync(join(here, "stand-ins/submission.json"), join(provider, "submission.json"));
    const started = Date.now();
    const result = await command("env", ["-u", "CLAUDECODE", process.execPath, bin, "review", "--reviewer", driver, "--skip", SKIPPED, "--format", "json", "--no-color"], demo, { ...env, PATH: [provider, dirname(process.execPath), env.PATH].join(delimiter) });
    const reviewMs = Date.now() - started;
    if (![0, 1].includes(result.code)) throw new Error(`${driver} review exited ${result.code}: ${result.stderr}`);
    const latest = JSON.parse(readFileSync(join(home, "last-review", repoId, "last-review.json"), "utf8"));
    const dir = latest.dir;
    const names = readdirSync(dir).sort();
    for (const name of required) if (!names.includes(name)) throw new Error(`${driver} review omitted ${name}`);
    const rawReport = readFileSync(join(dir, "report.json"), "utf8");
    const report = JSON.parse(rawReport);
    const scan = JSON.parse(readFileSync(join(dir, "scan.json"), "utf8"));
    const submission = JSON.parse(readFileSync(join(dir, "submission.json"), "utf8"));
    if (report.completion.status !== "complete" || submission.dropped.length !== 0 || submission.findings.length !== scan.candidates.length || scan.candidates.some((c) => !submission.findings.some((f) => f.candidate === c.id))) {
      throw new Error(`${driver} did not complete with every scanner candidate raised: ${JSON.stringify(report.completion)}`);
    }
    const context = { home, demo, repoId, runId: basename(dir), snapshot: readFileSync(join(provider, "snapshot-path"), "utf8"), generation: report.impact?.build?.generation ?? null };
    const { before, after } = report.completion.snapshot;
    context.snapshotHash = { raw: before, normalized: normalizedSnapshotHash(join(provider, "snapshot"), [before, after], context) };
    const output = join(destination, driver);
    mkdirSync(output, { recursive: true });
    const save = (name, text) => {
      const path = join(output, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    for (const name of names) save(`run/${name}`, normalize(name, readFileSync(join(dir, name), "utf8"), context));
    save("stdout.txt", normalize("report.json", result.stdout, context));
    save("stderr.txt", normalize("stderr.txt", result.stderr, context));
    save("exit-code.txt", `${result.code}\n`);
    for (const name of readdirSync(join(home, "receipts", repoId)).filter((n) => n.endsWith(".json")).sort()) {
      save(`home/receipts/REPO_ID/${name}`, normalize(name, readFileSync(join(home, "receipts", repoId, name), "utf8"), context));
    }
    save("home/last-review/REPO_ID/last-review.json", normalizedLastReview(readFileSync(join(home, "last-review", repoId, "last-review.json"), "utf8"), rawReport, normalize("report.json", rawReport, context), context));
    console.log(`golden: ${driver}, exit ${result.code}, ${scan.candidates.length} candidates raised, 0 dropped, ${names.length} run files, ${reviewMs} ms`);
  }
}

export async function record(destination = join(here, "expected")) {
  const prepared = await prepare();
  const staging = join(prepared.work, "recording");
  try {
    await capture(prepared, staging);
    mkdirSync(destination, { recursive: true });
    for (const driver of drivers) {
      // These are harness-owned recordings, never product data.
      rmSync(join(destination, driver), { recursive: true, force: true });
      cpSync(join(staging, driver), join(destination, driver), { recursive: true });
    }
  } finally {
    rmSync(prepared.work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await record(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
