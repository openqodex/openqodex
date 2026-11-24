// `openqodex demo [dir]`: builds the demo repo with planted bugs and scans it.
// The baseline is committed, the planted change is left uncommitted, and the
// secret is generated here so no key, real or fake, ships in the package.
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { randomInt } from "node:crypto";
import { promisify } from "node:util";
import { OpenQodexError } from "@openqodex/core";
import { assetPath } from "../assets.js";
import { EXIT_OK } from "../exit-codes.js";
import { parseFlags } from "../flags.js";
import { warn } from "../pipeline.js";
import { noteFolder } from "../telemetry/dispatch.js";
import { runScan } from "./scan.js";

const git$ = promisify(execFile);
const PLACEHOLDER = "{{GENERATED_SECRET}}";
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generatedSecret(): string {
  let key = "sk_live_";
  for (let i = 0; i < 24; i++) key += BASE62[randomInt(BASE62.length)];
  return key;
}

function targetDir(arg: string | undefined): string {
  if (arg === undefined) return mkdtempSync(join(tmpdir(), "openqodex-demo-"));
  const dir = resolve(arg);
  let entries: string[] | null = null;
  try {
    if (!statSync(dir).isDirectory()) throw new OpenQodexError(`${dir} is not a folder`);
    entries = readdirSync(dir);
  } catch (error) {
    if (error instanceof OpenQodexError) throw error;
  }
  if (entries !== null && entries.length > 0) throw new OpenQodexError(`${dir} is not empty; give an empty or new folder`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

async function git(dir: string, args: string[]): Promise<void> {
  const date = "2026-01-01T00:00:00Z";
  await git$(
    "git",
    [
      "-c", "user.name=OpenQodex demo",
      "-c", "user.email=demo@openqodex.invalid",
      "-c", "commit.gpgsign=false",
      "-c", "init.defaultBranch=main",
      "-c", "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
  );
}

export async function run(args: string[]): Promise<number> {
  const { global, positionals } = parseFlags(args, {
    positionals: 1,
    globals: ["--no-color", "--quiet", "--verbose", "--no-install", "--offline"],
  });
  // An inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and the like would
  // send the demo's commit and its scan into another repository. The demo
  // repo is the only one this command touches.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) delete process.env[key];
  }
  const source = assetPath("demo");
  const dir = targetDir(positionals[0]);
  noteFolder(dir);

  cpSync(join(source, "baseline"), dir, { recursive: true });
  await git(dir, ["init", "--quiet"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "--quiet", "-m", "Demo baseline"]);

  const planted = join(source, "planted");
  cpSync(planted, dir, { recursive: true });
  const secret = generatedSecret();
  for (const file of filesUnder(planted)) {
    const target = join(dir, relative(planted, file));
    const text = readFileSync(target, "utf8");
    if (text.includes(PLACEHOLDER)) writeFileSync(target, text.split(PLACEHOLDER).join(secret));
  }

  warn(`Demo repo built in ${dir}`);
  const outcome = await runScan({ flags: { ...global, cwd: dir }, scope: {}, demo: true });
  warn("");
  warn(`The demo repo is in ${dir}`);
  const installing = outcome.report?.scanners.filter((s) => s.status === "installing").length ?? 0;
  if (installing > 0) {
    warn(
      `${installing} scanner${installing === 1 ? " is" : "s are"} still installing; ` +
        "run `npx openqodex scan` here again in a minute to include them.",
    );
  }
  warn("For the AI review, open this folder in your coding agent and say: review my change with openqodex");
  warn("To install OpenQodex into your coding agent: npx openqodex init");
  return EXIT_OK;
}
