// `openqodex findings <numbers>`: the findings the developer named, in full,
// from the last review of this repository run on this machine. The receipt
// `review` prints names each finding by its number and title only; once the
// developer says which to fix ("fix 1 and 3"), the agent prints those here:
// where, the problem, why it matters, the fix, any suggested change and the
// source. `all` prints every finding.
//
// The review is the one recorded in the developer's own OpenQodex home
// (receipts.ts), never the newest folder under .openqodex/reviews/, which a
// branch can carry with any name and any text; and its report.json is
// printed only while it is the very text the review wrote (the record holds
// its sha256). It only reads and prints.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { OpenQodexError, findRepoRoot, isRepoState, readFileBounded, readRepoFile, renderFindingDetails } from "@openqodex/core";
import type { Report } from "@openqodex/core";
import { EXIT_OK } from "../exit-codes.js";
import { parseFlags } from "../flags.js";
import { openqodexHomeDir } from "../launcher.js";
import { readHomeLastReview } from "../receipts.js";

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_NUMBERS = 200;

// "1,3", "1, 3", "1 3" or "all", as given in one or more arguments.
function numbersOf(args: string[], findings: number, observations = 0, possible = 0): number[] {
  const count = findings + observations + possible;
  const words = args.join(",").split(/[\s,]+/).filter((w) => w !== "");
  if (words.length === 0) throw new OpenQodexError("name the findings to print by their numbers in the receipt, such as openqodex findings 1,3, or all");
  if (words.length === 1 && words[0] === "all") return Array.from({ length: findings }, (_, i) => i + 1);
  if (words.length > MAX_NUMBERS) throw new OpenQodexError(`name at most ${MAX_NUMBERS} findings at once, or all`);
  const out = new Set<number>();
  for (const w of words) {
    if (!/^[1-9]\d{0,5}$/.test(w)) throw new OpenQodexError(`${w} is not a finding number; use the numbers in the receipt, such as 1,3, or all`);
    const n = Number(w);
    if (n > count) {
      if (possible > 0) {
        // wording: session
        throw new OpenQodexError(`${n} is not an item of the last review. ${count === 1 ? "Its only item is numbered 1." : `Its ${count} items are numbered 1 to ${count}.`}`);
      }
      if (observations > 0) {
        const items = `${findings} ${findings === 1 ? "finding" : "findings"} and ${observations} ${observations === 1 ? "observation" : "observations"}`;
        throw new OpenQodexError(`${n} is not a finding or observation of the last review: it has ${items}, numbered 1 to ${count}`);
      }
      throw new OpenQodexError(`${n} is not a finding of the last review: it has ${count === 0 ? "no findings" : count === 1 ? "1 finding, number 1" : `${count} findings, numbered 1 to ${count}`}`);
    }
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function readReport(repoRoot: string, dir: string): string | null {
  const path = join(dir, "report.json");
  try {
    // In the repository: through the repo state reader, which follows no link.
    if (isRepoState(repoRoot, path) !== null) return readRepoFile(repoRoot, path, MAX_REPORT_BYTES);
    return readFileBounded(path, MAX_REPORT_BYTES, "", path, true);
  } catch {
    return null;
  }
}

export async function run(args: string[]): Promise<number> {
  const { global, positionals } = parseFlags(args, { positionals: MAX_NUMBERS, globals: ["--cwd"] });
  const repoRoot = await findRepoRoot(global.cwd);
  const last = readHomeLastReview(openqodexHomeDir(), repoRoot);
  if (last === null) throw new OpenQodexError("there is no review of this repository yet on this machine; run openqodex review first");
  const unverified = "there is no verified review of this repository to print: ";
  if (last === "unverified") throw new OpenQodexError(`${unverified}the record of the last review holds no hash of its report; run openqodex review again`);
  // Only the exact report.json the review wrote: same bytes, same hash.
  const text = readReport(repoRoot, last.dir);
  if (text === null || createHash("sha256").update(text, "utf8").digest("hex") !== last.report_sha256) {
    throw new OpenQodexError(`${unverified}the report of the last review is gone or changed since it was written; run openqodex review again`);
  }
  let report: Report | null = null;
  try {
    report = JSON.parse(text) as Report;
  } catch {
    report = null;
  }
  if (report === null || report.kind !== "review" || report.change_id !== last.change_id || !Array.isArray(report.findings) || (report.observations !== undefined && !Array.isArray(report.observations)) || (report.possible !== undefined && !Array.isArray(report.possible))) {
    throw new OpenQodexError(`${unverified}the report of the last review is not in the shape openqodex writes; run openqodex review again`);
  }
  const numbers = numbersOf(positionals, report.findings.length, report.observations?.length ?? 0, report.possible?.length ?? 0);
  process.stdout.write(`From the review in ${last.shown}\n\n${renderFindingDetails(report, numbers)}`);
  return EXIT_OK;
}
