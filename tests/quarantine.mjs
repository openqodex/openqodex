// The quarantine list (tests/quarantine.json): test files that failed at
// random, each with the issue that tracks its fix and the date it was
// listed. vitest.config.ts runs them in a project of their own, named
// quarantine, with one retry, and the unit project leaves them out.
//
// The rule: a file goes on the list only with an open issue, and comes off
// it in the change that fixes it. Two reds in a row on one file is a bug,
// never a flake (issue 116), so the retry never hides one: a file that fails
// its retry still fails the run. The list starts empty; it exists for the
// next file that fails at random, not to hold old ones.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const QUARANTINE_FILE = join(root, "tests", "quarantine.json");

/**
 * The problems of a quarantine list, one line each: an entry that is not
 * { file, issue, date }, a file that is not a test file of this repository,
 * an issue that is not a positive number, a date that is not YYYY-MM-DD.
 * @param {unknown} list
 * @param {string} base the folder the files are relative to
 * @returns {string[]}
 */
export function quarantineProblems(list, base = root) {
  if (!Array.isArray(list)) return ["the list is not an array"];
  const problems = [];
  const seen = new Set();
  for (const [i, entry] of list.entries()) {
    const at = `entry ${i + 1}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${at} is not an object`);
      continue;
    }
    const keys = Object.keys(entry).sort().join(",");
    if (keys !== "date,file,issue") problems.push(`${at} has the keys ${keys}, not date, file and issue`);
    const { file, issue, date } = entry;
    if (typeof file !== "string" || file === "" || isAbsolute(file) || file.split("/").includes("..") || !/\.test\.(ts|mjs)$/.test(file)) problems.push(`${at}: file ${JSON.stringify(file)} is not a test file path relative to the repository`);
    else if (!existsSync(join(base, file))) problems.push(`${at}: ${file} does not exist`);
    else if (seen.has(file)) problems.push(`${at}: ${file} is listed twice`);
    else seen.add(file);
    if (!Number.isInteger(issue) || issue <= 0) problems.push(`${at}: issue ${JSON.stringify(issue)} is not an issue number`);
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(`${at}: date ${JSON.stringify(date)} is not YYYY-MM-DD`);
  }
  return problems;
}

/**
 * The quarantined files, relative to the repository; throws on a list with
 * any problem, so a bad entry stops the run instead of running unseen.
 * @param {string} file
 * @returns {string[]}
 */
export function quarantined(file = QUARANTINE_FILE) {
  const list = JSON.parse(readFileSync(file, "utf8"));
  const problems = quarantineProblems(list, join(dirname(file), ".."));
  if (problems.length > 0) throw new Error(`${file}:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  return list.map((e) => e.file);
}
