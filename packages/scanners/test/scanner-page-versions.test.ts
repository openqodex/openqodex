// scripts/scanner-page-versions.mjs holds every version in docs/scanners.md
// to toolchain.json; scripts/docs-facts.mjs runs it in the gate (issue 187).
//
// Failure list, written before the code:
//   1. A scanner's own "- Version:" line names an old version and the check
//      passes (golangci-lint said 2.12.2 while the pin was 2.14.0).
//   2. An old version in a scanner's link, its prose or another table's row
//      passes.
//   3. A version with no tool to hold it to passes unchecked.
//   4. The current page fails, so the gate is red on a true page.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pinsOf, scannerPageVersionProblems } from "../../../scripts/scanner-page-versions.mjs";

const root = new URL("../../../", import.meta.url);
const page = readFileSync(new URL("docs/scanners.md", root), "utf8");
const tools = JSON.parse(readFileSync(new URL("packages/scanners/toolchain.json", root), "utf8")).tools;
const pins = pinsOf(tools);
const golangci = tools.golangci.version as string;
const check = (text: string): string[] => scannerPageVersionProblems(text, pins);
const lineOf = (text: string, needle: string): number => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("versions on the scanners page", () => {
  it("passes the current page", () => {
    expect(check(page)).toEqual([]);
  });

  it("fails a stale Version line in a scanner's own section", () => {
    const stale = page.replace(`- Version: ${golangci}.`, "- Version: 2.12.2.");
    expect(stale).not.toBe(page);
    expect(check(stale)).toEqual([`line ${lineOf(stale, "- Version: 2.12.2.")}: names golangci-lint at 2.12.2; toolchain.json pins ${golangci}`]);
  });

  it("fails a stale version in a link, in prose and in another table's row", () => {
    const link = page.replace(`cargo-deny/blob/${tools["cargo-deny"].version}/LICENSE-MIT`, "cargo-deny/blob/0.19.0/LICENSE-MIT");
    expect(check(link)).toEqual([expect.stringMatching(/names cargo-deny at 0\.19\.0/)]);
    const prose = page.replace(`hadolint ${tools.hadolint.version} cannot parse`, "hadolint 2.12.0 cannot parse");
    expect(check(prose)).toEqual([expect.stringMatching(/names hadolint at 2\.12\.0/)]);
    const row = page.replace(`| ruff | ${tools.ruff.version} |`, "| ruff | 0.7.0 |");
    expect(check(row)).toEqual([expect.stringMatching(/names ruff at 0\.7\.0/)]);
  });

  it("fails a version with no tool to hold it to", () => {
    const loose = `${page}\n## Notes\n\nSome release 9.9.9 changed this.\n`;
    expect(check(loose)).toEqual([expect.stringMatching(/names version 9\.9\.9 outside any tool's section or row/)]);
  });
});
