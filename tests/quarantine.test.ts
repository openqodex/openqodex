// The quarantine list (tests/quarantine.json, read by tests/quarantine.mjs).
// Ways it could fail, written before the code:
// 1. A listed file that was renamed or removed keeps its entry, so the list
//    names a flake nobody runs, and the file under its new name is never
//    held apart.
// 2. A file is listed with no issue, so nothing tracks its fix and the
//    retry hides it for good.
// 3. A bad entry is passed over instead of stopping the run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { QUARANTINE_FILE, quarantined, quarantineProblems } from "./quarantine.mjs";
import { removeTempDirs, tempDir } from "./temp-dirs.mjs";

afterAll(removeTempDirs);

// A repository folder with tests/quarantine.json holding `list`, and one
// real test file, a/real.test.ts.
function listed(list: unknown): string {
  const root = tempDir("oq-quarantine-");
  mkdirSync(join(root, "tests"));
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a", "real.test.ts"), "");
  const file = join(root, "tests", "quarantine.json");
  writeFileSync(file, JSON.stringify(list));
  return file;
}

describe("the quarantine list", () => {
  it("names only test files that exist, each with an issue number and a date (1, 2)", () => {
    expect(quarantineProblems(JSON.parse(readFileSync(QUARANTINE_FILE, "utf8")))).toEqual([]);
  });

  it("reads a good entry as its file (3)", () => {
    expect(quarantined(listed([{ file: "a/real.test.ts", issue: 294, date: "2026-11-08" }]))).toEqual(["a/real.test.ts"]);
  });

  it("stops on a missing file, a missing or wrong issue, a bad date or a path out of the repository, naming each (1, 2, 3)", () => {
    const bad = [
      { file: "a/gone.test.ts", issue: 1, date: "2026-11-08" },
      { file: "a/real.test.ts", date: "2026-11-08" },
      { file: "a/real.test.ts", issue: "#294", date: "2026-11-08" },
      { file: "a/real.test.ts", issue: 294, date: "8 November" },
      { file: "../outside.test.ts", issue: 294, date: "2026-11-08" },
    ];
    const run = () => quarantined(listed(bad));
    expect(run).toThrow(/entry 1: a\/gone\.test\.ts does not exist/);
    expect(run).toThrow(/entry 2 has the keys date,file, not date, file and issue/);
    expect(run).toThrow(/entry 2: issue undefined is not an issue number/);
    expect(run).toThrow(/entry 3: issue "#294" is not an issue number/);
    expect(run).toThrow(/entry 4: date "8 November" is not YYYY-MM-DD/);
    expect(run).toThrow(/entry 5: file "\.\.\/outside\.test\.ts" is not a test file path/);
  });
});
