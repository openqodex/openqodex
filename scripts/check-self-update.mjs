#!/usr/bin/env node
// The release check for the self-update, run after every publish by the
// release workflow and by a person when needed. Real npm packages, a temp
// HOME, nothing faked.
//
//   node scripts/check-self-update.mjs --from <x.y.z | previous> --to <x.y.z> [--route daily|now|both]
//
// Nothing of a release runs before it is checked the way the updater checks
// one: <from> and <to> are downloaded by exact version, their sha512 must
// match the registry's and their SLSA provenance must verify with Sigstore
// as signed by this repository's release workflow on main
// (self-update-check-lib.mjs, with this repository's own modules). Every
// process it starts gets an environment built from an allowlist, never the
// one it runs in, so no token of the job reaches a package. The release
// workflow runs it in a job of its own, after the publish, with no secret.
//
// For each route, in a fresh HOME:
//  1. installs the checked <from> with `init` for all four agents, in user
//     scope (in one repository) and in project scope (in another);
//  2. edits what a developer edits: an agent file of each agent in both
//     scopes, the Claude Code settings, the global instruction files, the
//     user config, the repo config and its instructions;
//  3. records every file (sha256 and mode) in the HOME and both repositories;
//  4. updates: `now` runs `openqodex update --now` through the launcher;
//     `daily` runs `hook check` through the launcher and waits for the
//     detached worker, with the test seam (OPENQODEX_E2E=1) only lifting the
//     24 hour age rule, so a fresh release can be checked;
//  5. fails on any change outside the runtime state (a new runtime folder,
//     runtime/current, update.json): an update writes no agent file, no
//     setting and nothing in a repository;
//  6. when <from> and <to> declare the same contract (src/contract.ts),
//     requires every command the active procedure (`guide skill`) gives the
//     agent to be allowed by the recorded Claude Code permission rules, and
//     names the files `init` would refresh when one is not. When they
//     differ, the daily route must leave <to> waiting for a foreground
//     update, and after `init` refreshes the files every rule must cover
//     the procedure and every edit from step 2 must be byte for byte as it was.
//
// Needs the network and the real registry. Stops at the first failure and
// keeps the temp HOME for a look.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { boxEnv, cleanEnv, loadVerifier, verifiedRelease } from "./self-update-check-lib.mjs";

const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const to = value("--to");
const route = value("--route") ?? "both";
const PLAIN = /^\d+\.\d+\.\d+$/;
if ((!PLAIN.test(value("--from") ?? "") && value("--from") !== "previous") || !PLAIN.test(to ?? "") || !["daily", "now", "both"].includes(route)) {
  console.error("usage: node scripts/check-self-update.mjs --from <x.y.z | previous> --to <x.y.z> [--route daily|now|both]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let box = null;
function fail(line) {
  console.error(`FAIL: ${line}${box === null ? "" : `\nThe temp HOME is kept for a look: ${box.home}`}`);
  process.exit(1);
}

// The contract each version declares in the registry (src/contract.ts); null
// for a release from before contracts.
const metadata = await (await fetch("https://registry.npmjs.org/openqodex")).json();
// `previous`: the newest release below <to>, as the release workflow asks.
const parts = (v) => v.split(".").map(Number);
const below = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
const from =
  value("--from") === "previous"
    ? Object.keys(metadata.versions ?? {}).filter((v) => PLAIN.test(v) && below(v, to) < 0).sort(below).pop()
    : value("--from");
if (from === undefined) {
  console.error(`FAIL: no release below ${to} on the registry`);
  process.exit(1);
}
const contractOf = (v) => {
  const block = metadata.versions?.[v]?.openqodex;
  return block && Number.isInteger(block.agentContract) && Number.isInteger(block.configFormat) ? `${block.agentContract}/${block.configFormat}` : null;
};
if (metadata.versions?.[from] === undefined || metadata.versions?.[to] === undefined) fail(`${from} or ${to} is not on the registry`);
const sameContract = contractOf(from) === contractOf(to);
process.stdout.write(`contracts: ${from} ${contractOf(from) ?? "none"}, ${to} ${contractOf(to) ?? "none"}\n`);

// Both releases, checked before anything of them runs; <to> is checked
// here too, though the updater checks it again before it switches.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releases = realpathSync(mkdtempSync(join(tmpdir(), "oq-self-update-releases-")));
let fromBin;
try {
  const verifier = await loadVerifier(repoRoot);
  fromBin = await verifiedRelease(from, metadata, join(releases, from), verifier);
  await verifiedRelease(to, metadata, join(releases, to), verifier);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
process.stdout.write(`checked: ${from} and ${to} are this repository's releases\n`);

function setup(name) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), `oq-self-update-${name}-`)));
  const b = { top, home: join(top, "home"), oqHome: join(top, "home", ".openqodex"), user: join(top, "user-repo"), project: join(top, "project-repo") };
  for (const dir of [b.home, b.user, b.project]) mkdirSync(dir, { recursive: true });
  // What the check sets on top of the allowlist (self-update-check-lib.mjs).
  b.set = boxEnv(b.home, b.oqHome);
  b.launcher = join(b.oqHome, "bin", "openqodex");
  return b;
}

// The one place a process starts: with the allowlisted environment, never
// this script's own.
function run(cwd, command, argv, extra = {}, input = "") {
  return spawnSync(command, argv, { cwd, env: cleanEnv(process.env, { ...box.set, ...extra }), input, encoding: "utf8", timeout: 600_000 });
}

function step(what, cwd, command, argv, extra = {}, input = "") {
  const r = run(cwd, command, argv, extra, input);
  process.stdout.write(`$ ${what}: exit ${r.status}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  return r;
}

function git(cwd, ...argv) {
  const r = run(cwd, "git", argv);
  if (r.status !== 0) fail(`git ${argv.join(" ")}: ${r.stderr}`);
}

// init of the checked <from>, with --no-review where that version knows it.
function initFrom(cwd, extra) {
  const base = [fromBin, "init", "--yes", "--agent", "all", ...extra];
  let r = step(`init ${from} ${extra.join(" ")}`, cwd, process.execPath, [...base, "--no-review"]);
  if (r.status !== 0 && /unknown argument: --no-review/.test(`${r.stdout}${r.stderr}`)) r = step(`init ${from} ${extra.join(" ")}`, cwd, process.execPath, base);
  if (r.status !== 0) fail(`openqodex@${from} init ${extra.join(" ")} did not succeed`);
}

// Every regular file and link under the folders, by path: sha256 and mode.
function inventory(b) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const st = lstatSync(full);
        const body = entry.isSymbolicLink() ? `link` : createHash("sha256").update(readFileSync(full)).digest("hex");
        out.set(relative(b.top, full), `${body} ${(st.mode & 0o7777).toString(8)}`);
      }
    }
  };
  for (const dir of [b.home, b.user, b.project]) walk(dir);
  return out;
}

// What an update may write: a runtime copy, the active record, its own state.
const RUNTIME_STATE = /^home\/\.openqodex\/(runtime\/[0-9][0-9A-Za-z.+-]*\/|runtime\/current$|update\.json$)/;

function changesOutsideRuntime(before, after) {
  const changed = [];
  for (const [path, sum] of after) if (before.get(path) !== sum && !RUNTIME_STATE.test(path)) changed.push(`${before.has(path) ? "changed" : "added"} ${path}`);
  for (const path of before.keys()) if (!after.has(path) && !RUNTIME_STATE.test(path)) changed.push(`removed ${path}`);
  return changed;
}

// What a developer edits after installing, in every agent's files, both scopes.
const EDITS = [
  ["home/.openqodex/config.yaml", (p) => writeFileSync(p, "# my laptop\nupdate: on # keep me current\nreviewer_web: off\n")],
  ["home/.claude/CLAUDE.md", (p) => appendFileSync(p, "\nMy own rule for Claude.\n")],
  ["home/.codex/AGENTS.md", (p) => appendFileSync(p, "\nMy own rule for Codex.\n")],
  ["home/.cursor/skills/openqodex/SKILL.md", (p) => appendFileSync(p, "\nMy own note for Cursor.\n")],
  ["home/Documents/Cline/Rules/openqodex.md", (p) => appendFileSync(p, "\nMy own note for Cline.\n")],
  [
    "home/.claude/settings.json",
    (p) => {
      const s = JSON.parse(readFileSync(p, "utf8"));
      s.model = "opus";
      s.permissions = { ...s.permissions, allow: [...(s.permissions?.allow ?? []), "Bash(ls)"], deny: ["Bash(rm -rf *)"] };
      s.hooks = { ...s.hooks, PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] };
      writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`);
    },
  ],
  ["user-repo/CLAUDE.md", (p) => appendFileSync(p, "\nThe team's own rule.\n")],
  ["user-repo/.openqodex/config.yaml", (p) => appendFileSync(p, "\n# chosen by the team\n")],
  ["user-repo/.openqodex/custom-instructions.md", (p) => appendFileSync(p, "\nPayments code needs a second look.\n")],
  ["project-repo/.claude/skills/openqodex/SKILL.md", (p) => appendFileSync(p, "\nThe team's note for Claude.\n")],
  ["project-repo/.agents/skills/openqodex/SKILL.md", (p) => appendFileSync(p, "\nThe team's note for Codex and Cursor.\n")],
  ["project-repo/.cursor/rules/openqodex.mdc", (p) => appendFileSync(p, "\nThe team's Cursor rule.\n")],
  ["project-repo/.clinerules/openqodex.md", (p) => appendFileSync(p, "\nThe team's Cline rule.\n")],
  ["project-repo/AGENTS.md", (p) => appendFileSync(p, "\nThe team's own rule.\n")],
];

const current = (b) => (existsSync(join(b.oqHome, "runtime/current")) ? readFileSync(join(b.oqHome, "runtime/current"), "utf8").split("\n")[0] : null);
const state = (b) => {
  try {
    return JSON.parse(readFileSync(join(b.oqHome, "update.json"), "utf8"));
  } catch {
    return {};
  }
};

// The commands the active procedure gives the agent to run, as an agent
// runs them: review and guide lines, not a review of a named branch or pull
// request, which no exact rule covers.
function procedureCommands(b) {
  const r = step("guide skill through the launcher", b.user, "sh", [b.launcher, "guide", "skill"]);
  if (r.status !== 0) fail("guide skill failed");
  const escaped = b.launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = [...r.stdout.matchAll(new RegExp(`'?${escaped}'? [^\`\\n]*`, "g"))].map((m) => m[0].trim().replace(/^'([^']+)'/, "$1"));
  return [...new Set(lines.filter((l) => / (review|guide)\b/.test(l) && !l.includes("<") && !/ review [^-]/.test(l)))];
}

// Claude Code's matching as its permissions page states it: a rule without
// `*` matches one exact command; a trailing " *" also matches the bare one.
function uncovered(b, commands) {
  const settings = JSON.parse(readFileSync(join(b.home, ".claude/settings.json"), "utf8"));
  const rules = (settings.permissions?.allow ?? []).filter((r) => typeof r === "string" && r.startsWith("Bash(")).map((r) => r.slice(5, -1).replace(/^'([^']+)'/, "$1"));
  const covers = (rule, c) => (rule.endsWith(" *") ? c === rule.slice(0, -2) || c.startsWith(rule.slice(0, -1)) : c === rule);
  return commands.filter((c) => !rules.some((rule) => covers(rule, c)));
}

function wouldRefresh(b) {
  const r = step("init --dry-run through the launcher", b.user, "sh", [b.launcher, "init", "--dry-run", "--agent", "all"]);
  return r.stdout.split("\n").filter((l) => /^\s+(update|replace)\s/.test(l)).map((l) => l.trim());
}

async function check(name) {
  box = setup(name);
  const b = box;
  process.stdout.write(`\n== route ${name}: ${from} to ${to} in ${b.top}\n`);
  git(b.user, "init", "-q");
  git(b.project, "init", "-q");
  for (const repo of [b.user, b.project]) {
    git(repo, "config", "maintenance.auto", "false");
    git(repo, "-c", "user.email=check@example.com", "-c", "user.name=Check", "commit", "-q", "--allow-empty", "-m", "start");
  }
  initFrom(b.user, ["--hook", "pre-push"]);
  initFrom(b.project, ["--project", "--hook", "none"]);
  if (current(b) !== from) fail(`after init the launcher points at ${current(b)}, not ${from}`);
  for (const [path, edit] of EDITS) {
    const full = join(b.top, path);
    if (!existsSync(full) && !path.endsWith("config.yaml")) fail(`${path} was not written by openqodex@${from} init`);
    edit(full);
  }
  rmSync(join(b.oqHome, "update.json"), { force: true });
  const before = inventory(b);
  const edited = new Map(EDITS.map(([path]) => [path, before.get(path)]));

  let expect = to;
  if (name === "now") {
    const r = step("update --now through the launcher", b.user, "sh", [b.launcher, "update", "--now"]);
    if (r.status !== 0) fail("update --now failed");
  } else {
    // A worker that reads contracts leaves a release of another contract waiting.
    const holds = !sameContract && contractOf(from) !== null;
    if (holds) expect = from;
    const r = step("hook check through the launcher", b.user, "sh", [b.launcher, "hook", "check"], { OPENQODEX_E2E: "1", OPENQODEX_UPDATE_MIN_AGE_MS: "0" }, "{}");
    if (r.status !== 0) fail("hook check failed");
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const s = state(b);
      if (current(b) !== from || s.lastError || (holds && s.held)) break;
      await sleep(1000);
    }
    if (holds && state(b).held?.version !== to) fail(`the daily worker did not leave ${to}, of another contract, waiting: ${JSON.stringify(state(b))}`);
  }
  process.stdout.write(`update.json:\n${JSON.stringify(state(b), null, 2)}\n`);
  if (current(b) !== expect) fail(`the launcher points at ${current(b)}, not ${expect}`);
  const version = step("--version through the launcher", b.user, "sh", [b.launcher, "--version"]);
  if (version.stdout.trim() !== expect) fail(`the launcher printed ${version.stdout.trim()}, not ${expect}`);

  const outside = changesOutsideRuntime(before, inventory(b));
  if (outside.length > 0) fail(`the update changed files outside the runtime state:\n  ${outside.join("\n  ")}`);
  if (expect === from) return;

  if (sameContract) {
    const missing = uncovered(b, procedureCommands(b));
    if (missing.length > 0) {
      fail(`${to} keeps the contract of ${from}, but the permission rules do not allow what its procedure runs:\n  ${missing.join("\n  ")}\ninit would refresh:\n  ${wouldRefresh(b).join("\n  ")}`);
    }
    return;
  }
  // Another contract: the developer runs init, which refreshes the files
  // OpenQodex wrote and keeps every edit.
  process.stdout.write(`files init would refresh:\n  ${wouldRefresh(b).join("\n  ")}\n`);
  const refresh = step("init through the launcher", b.user, "sh", [b.launcher, "init", "--yes", "--agent", "all", "--hook", "pre-push", "--no-review"]);
  if (refresh.status !== 0) fail("init after the update failed");
  const missing = uncovered(b, procedureCommands(b));
  if (missing.length > 0) fail(`after init the permission rules do not allow what the procedure runs:\n  ${missing.join("\n  ")}`);
  const after = inventory(b);
  const lost = [...edited.keys()].filter((path) => !after.has(path));
  const keptBytes = ["home/.cursor/skills/openqodex/SKILL.md", "home/Documents/Cline/Rules/openqodex.md", "home/.openqodex/config.yaml", "user-repo/.openqodex/config.yaml", "user-repo/.openqodex/custom-instructions.md"].filter((p) => after.get(p) !== edited.get(p));
  if (lost.length + keptBytes.length > 0) fail(`init lost an edit:\n  ${[...lost, ...keptBytes].join("\n  ")}`);
  for (const [path, mark] of [["home/.claude/CLAUDE.md", "My own rule for Claude."], ["home/.codex/AGENTS.md", "My own rule for Codex."], ["user-repo/CLAUDE.md", "The team's own rule."]]) {
    if (!readFileSync(join(b.top, path), "utf8").includes(mark)) fail(`init lost the developer's text in ${path}`);
  }
  const settings = JSON.parse(readFileSync(join(b.home, ".claude/settings.json"), "utf8"));
  if (settings.model !== "opus" || !settings.permissions?.deny?.includes("Bash(rm -rf *)") || !settings.permissions?.allow?.includes("Bash(ls)") || !settings.hooks?.PostToolUse) {
    fail("init lost a setting the developer made in ~/.claude/settings.json");
  }
}

for (const name of route === "both" ? ["daily", "now"] : [route]) {
  await check(name);
  // No run of the check may create the usage data's install id.
  if (existsSync(join(box.oqHome, "telemetry"))) fail(`${name}: a run created ${join(box.oqHome, "telemetry")}; the check must send no usage data`);
  rmSync(box.top, { recursive: true, force: true });
  box = null;
}
rmSync(releases, { recursive: true, force: true });
process.stdout.write(`PASS: ${from} to ${to} (${route})\n`);
