#!/usr/bin/env node
// The release check for the self-update, run by a person after a publish:
// installs openqodex@<from> from npm into a temp HOME with `init`, makes a
// check due, runs a normal command through the launcher, waits for the
// detached worker, then requires that the launcher runs <to>.
//
//   node scripts/check-self-update.mjs --from 0.3.0 --to 0.3.1 [--now]
//
// Without --now the worker keeps the 24 hour age rule, so run it once <to>
// is a day old. With --now it runs `openqodex update --now` through the
// launcher instead of waiting for the daily check (same verification).
// Needs the network and the real registry; nothing is faked.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const from = value("--from");
const to = value("--to");
const now = args.includes("--now");
const PLAIN = /^\d+\.\d+\.\d+$/;
if (!PLAIN.test(from ?? "") || !PLAIN.test(to ?? "")) {
  console.error("usage: node scripts/check-self-update.mjs --from <x.y.z> --to <x.y.z> [--now]");
  process.exit(2);
}

const top = realpathSync(mkdtempSync(join(tmpdir(), "oq-self-update-check-")));
const home = join(top, "home");
const oqHome = join(home, ".openqodex");
const repo = join(top, "repo");
mkdirSync(home, { recursive: true });
mkdirSync(repo, { recursive: true });
const env = { ...process.env, HOME: home, OPENQODEX_HOME: oqHome };
for (const key of ["CI", "OPENQODEX_OFFLINE", "OPENQODEX_AUTO_UPDATE", "OPENQODEX_E2E", "OPENQODEX_UPDATE_AS", "OPENQODEX_UPDATE_MIN_AGE_MS", "OPENQODEX_LAUNCHER", "CODEX_HOME"]) delete env[key];

function step(what, command, argv, input = "") {
  const r = spawnSync(command, argv, { cwd: repo, env, input, encoding: "utf8", timeout: 600_000 });
  process.stdout.write(`$ ${what}: exit ${r.status}\n${r.stdout}${r.stderr}`);
  return r;
}
function fail(line) {
  console.error(`FAIL: ${line}\nThe temp HOME is kept for a look: ${home}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launcher = join(oqHome, "bin/openqodex");
// Line 1 of the active record is the version the launcher runs; line 2, when
// there, is the one to roll back to.
const current = () => (existsSync(join(oqHome, "runtime/current")) ? readFileSync(join(oqHome, "runtime/current"), "utf8").split("\n")[0] : null);

step("git init", "git", ["init", "-q"]);
const init = step(`install ${from}`, "npx", ["-y", `openqodex@${from}`, "init", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo"]);
if (init.status !== 0) fail(`openqodex@${from} init did not succeed`);
if (current() !== from) fail(`after init the launcher points at ${current()}, not ${from}`);
// No state: a check is due.
rmSync(join(oqHome, "update.json"), { force: true });

if (now) {
  const r = step("update --now through the launcher", "sh", [launcher, "update", "--now"]);
  if (r.status !== 0) fail("update --now failed");
} else {
  const started = Date.now();
  const r = step("hook check through the launcher", "sh", [launcher, "hook", "check"], "{}");
  process.stdout.write(`the command returned in ${Date.now() - started} ms\n`);
  if (r.status !== 0) fail("hook check failed");
  // The detached worker ends within ten minutes: wait for the switch, or
  // for the error it records.
  const lastError = () => {
    try {
      return JSON.parse(readFileSync(join(oqHome, "update.json"), "utf8")).lastError ?? null;
    } catch {
      return null;
    }
  };
  const deadline = Date.now() + 10 * 60_000;
  while (current() === from && lastError() === null && Date.now() < deadline) await sleep(1000);
}

const state = existsSync(join(oqHome, "update.json")) ? readFileSync(join(oqHome, "update.json"), "utf8") : "(none)";
process.stdout.write(`update.json:\n${state}\n`);
if (current() !== to) fail(`the launcher points at ${current()}, not ${to}`);
const version = step("--version through the launcher", "sh", [launcher, "--version"]);
if (version.stdout.trim() !== to) fail(`the launcher printed ${version.stdout.trim()}, not ${to}`);
process.stdout.write(`PASS: ${from} updated itself to ${to}\n`);
rmSync(top, { recursive: true, force: true });
