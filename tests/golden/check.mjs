import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { record } from "./record.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(root.length + 1)).sort();
}

export function compareTrees(expected, actual) {
  const names = [...new Set([...filesUnder(expected), ...filesUnder(actual)])].sort();
  let diff = "";
  const changed = [];
  for (const name of names) {
    const left = join(expected, name);
    const right = join(actual, name);
    if (existsSync(left) && existsSync(right) && readFileSync(left).equals(readFileSync(right))) continue;
    changed.push(name);
    const result = spawnSync("diff", ["-u", "--label", `expected/${name}`, "--label", `actual/${name}`, existsSync(left) ? left : "/dev/null", existsSync(right) ? right : "/dev/null"], { encoding: "utf8" });
    if (result.error || result.status !== 1) throw result.error ?? new Error(`diff exited ${result.status}: ${result.stderr}`);
    diff += result.stdout;
  }
  return { files: names.length, differences: changed.length, changed, diff };
}

export async function check(expected = join(here, "expected")) {
  const actual = mkdtempSync(join(tmpdir(), "oq-golden-check-"));
  try {
    await record(actual);
    const result = compareTrees(resolve(expected), actual);
    if (result.diff) process.stdout.write(result.diff);
    for (const name of result.changed) console.log(`golden: differs: ${name}`);
    console.log(`golden: ${result.files} files, ${result.differences} differences`);
    return result.differences === 0 ? 0 : 1;
  } finally {
    rmSync(actual, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await check(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
