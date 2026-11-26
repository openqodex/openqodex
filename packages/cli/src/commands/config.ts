// `openqodex config migrate [--write]`: the rewrite of the repo's config
// that the CONFIG_CHANGES table of the core package asks for (renamed keys,
// removed keys, the 0.1.0 root file moved into .openqodex/). Without
// --write it prints the changes and the file as it would be, and writes
// nothing. Comments are kept, and a rewrite that would change what the
// config does is refused.
import { applyMigration, findRepoRoot, OpenQodexError, planMigration } from "@openqodex/core";
import { EXIT_OK } from "../exit-codes.js";
import { parseFlags } from "../flags.js";
import { noteSub } from "../telemetry/dispatch.js";

const USAGE = "usage: openqodex config migrate [--write] [--cwd <dir>]";

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export async function run(args: string[]): Promise<number> {
  const { global, bools, positionals } = parseFlags(args, { bools: ["--write"], positionals: 1, globals: ["--cwd"] });
  if (positionals[0] !== "migrate") throw new OpenQodexError(`${positionals[0] === undefined ? "name what to do" : `unknown: ${positionals[0]}`}\n${USAGE}`);
  noteSub("migrate");
  const repoRoot = await findRepoRoot(global.cwd);
  const m = planMigration(repoRoot);
  if (m.file === null) {
    out("No config file in this repository: nothing to migrate.");
    return EXIT_OK;
  }
  if (m.text === null) {
    out(`${m.file} needs no change.`);
    return EXIT_OK;
  }
  out(`${m.file}:`);
  for (const change of m.changes) out(`  ${change}`);
  if (!bools.has("--write")) {
    out();
    out(`${m.target} would read:`);
    for (const line of m.text.replace(/\n$/, "").split("\n")) out(`  ${line}`);
    out();
    out("Nothing was written. To write it: openqodex config migrate --write");
    return EXIT_OK;
  }
  applyMigration(repoRoot, m);
  out(m.target === m.file ? `Wrote ${m.target}.` : `Wrote ${m.target} and removed ${m.file}.`);
  return EXIT_OK;
}
