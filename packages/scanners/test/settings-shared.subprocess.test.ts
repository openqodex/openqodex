// Real binaries for the settings that ruff and SQLFluff read from files other
// tools share (pyproject.toml, setup.cfg). Each case guards one form that a
// reader of lines and words got wrong: the scanner is shown to obey the
// form, and the runner to raise its settings-file note, or, where the
// scanner ignores the form, to raise none. Run by the end-to-end config, not
// the unit config.
import { makeLineSet } from "../../../tests/line-set.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseConfig } from "@openqodex/core";
import type { BuiltinScanner } from "@openqodex/core";
import { runScanners } from "@openqodex/scanners";
import { afterAll, describe, expect, it } from "vitest";
import { installedOnly } from "./subprocess-support.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

// Removes the temp folders this file made.
afterAll(removeTempDirs);

// The lines of `head` that a line diff from `base` marks as added: those
// outside a longest common run of lines.
function addedLines(base: string, head: string): ReturnType<typeof makeLineSet> {
  const a = base.split("\n");
  const b = head.split("\n");
  const longest = a.map(() => b.map(() => 0));
  const at = (i: number, j: number): number => (i < a.length && j < b.length ? (longest[i]?.[j] ?? 0) : 0);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) (longest[i] as number[])[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  const added = makeLineSet();
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && at(i + 1, j) >= at(i, j + 1)) {
      i++;
    } else {
      added.add(j + 1);
      j++;
    }
  }
  return added;
}

// A scan of `head` with `settings` changed from `base` (null: the base has
// no such file), every line of `code` new. Returns the rule ids the scanner
// reported on `code` and the settings-file notes, as "<scanner>:<file>".
async function run(scanner: BuiltinScanner, code: Record<string, string>, settings: string, base: string | null, head: string) {
  const repo = tempDir(`oq-shared-${scanner}-`);
  for (const [name, body] of Object.entries({ ...code, [settings]: head })) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), body);
  }
  const paths = [...Object.keys(code), settings];
  const coverage = new Map(Object.entries(code).map(([p, body]) => [p, addedLines("", body)]));
  coverage.set(settings, addedLines(base ?? "", head));
  const result = await runScanners({
    repoDir: repo,
    changedPaths: paths,
    coverage,
    baseText: async (p) => (p === settings ? base : null),
    config: parseConfig("").config,
    resolveTool: installedOnly(),
    only: [scanner],
  });
  expect(result.scan.scanners[0]).toMatchObject({ status: "ran", reason: null });
  const rules = result.scan.candidates.filter((c) => c.source === scanner && c.ruleId !== "settings-file").map((c) => c.ruleId).sort();
  const notes = result.scan.candidates.filter((c) => c.ruleId === "settings-file").map((c) => `${c.source}:${c.filePath}`);
  return { rules, notes };
}

const PROJECT = '[project]\nname = "app"\n';
const UNUSED_IMPORT = { "app/main.py": "import os\n" };
const OLD_TYPING = { "app/main.py": "from typing import List\n\n\ndef first(x: List[int]) -> int:\n    return x[0]\n" };
const NULL_COMPARISON = { "db/report.sql": "SELECT id FROM users WHERE deleted_at = NULL;\n" };

describe("ruff settings in pyproject.toml, by meaning", () => {
  it("finds F401 with no settings, the control for the cases below", async () => {
    expect(await run("ruff", UNUSED_IMPORT, "pyproject.toml", PROJECT, PROJECT)).toEqual({ rules: ["F401"], notes: [] });
  });

  for (const [label, head] of [
    ["an escaped header", `${PROJECT}\n[tool."\\u0072uff".lint]\nignore = ["F401"]\n`],
    ["a quoted header", `${PROJECT}\n[tool."ruff".lint]\nignore = ["F401"]\n`],
    ["a header with a comment after it", `${PROJECT}\n[tool.ruff.lint] # shared settings\nignore = ["F401"]\n`],
    ["a dotted key's array under [tool]", `${PROJECT}\n[tool]\nruff.lint.ignore = [\n  "E501",\n  "F401",\n]\n`],
  ] as const) {
    it(`obeys ${label} that switches F401 off, and the change raises the ruff note`, async () => {
      expect(await run("ruff", UNUSED_IMPORT, "pyproject.toml", PROJECT, head)).toEqual({ rules: [], notes: ["ruff:pyproject.toml"] });
    }, 300_000);
  }

  // ruff 0.8.4 takes its target version from requires-python beside a
  // [tool.ruff] table; a lower one silences the pyupgrade rules.
  it("obeys a lowered requires-python beside [tool.ruff], and the change raises the ruff note", async () => {
    const pyproject = (version: string) => `[project]\nname = "app"\nrequires-python = "${version}"\n\n[tool.ruff.lint]\nselect = ["UP"]\n`;
    const before = await run("ruff", OLD_TYPING, "pyproject.toml", pyproject(">=3.12"), pyproject(">=3.12"));
    expect(before).toEqual({ rules: ["UP006", "UP035"], notes: [] });
    expect(await run("ruff", OLD_TYPING, "pyproject.toml", pyproject(">=3.12"), pyproject(">=3.8"))).toEqual({ rules: [], notes: ["ruff:pyproject.toml"] });
  }, 300_000);
});

describe("SQLFluff settings in pyproject.toml and setup.cfg, by meaning", () => {
  it("finds CV05 with no settings, the control for the cases below", async () => {
    expect(await run("sqlfluff", NULL_COMPARISON, "setup.cfg", "[metadata]\nname = app\n", "[metadata]\nname = app\n")).toEqual({ rules: ["CV05"], notes: [] });
  }, 300_000);

  for (const [label, head] of [
    ["an escaped header", `${PROJECT}\n[tool."\\u0073qlfluff".core]\nexclude_rules = "CV05"\n`],
    ["a quoted header", `${PROJECT}\n[tool."sqlfluff".core]\nexclude_rules = "CV05"\n`],
    ["a header with a comment after it", `${PROJECT}\n[tool.sqlfluff.core] # shared settings\nexclude_rules = "CV05"\n`],
    ["a dotted key's array under [tool]", `${PROJECT}\n[tool]\nsqlfluff.core.exclude_rules = [\n  "AL01",\n  "CV05",\n]\n`],
  ] as const) {
    it(`obeys ${label} in pyproject.toml that leaves CV05 out, and the change raises the sqlfluff note`, async () => {
      expect(await run("sqlfluff", NULL_COMPARISON, "pyproject.toml", PROJECT, head)).toEqual({ rules: [], notes: ["sqlfluff:pyproject.toml"] });
    }, 300_000);
  }

  for (const [label, base, head] of [
    ["a [DEFAULT] key, which configparser gives every section", "[sqlfluff]\ndialect = postgres\n", "[DEFAULT]\nexclude_rules = CV05\n\n[sqlfluff]\ndialect = postgres\n"],
    ["an indented header, which configparser reads as the value above going on", "[sqlfluff]\ntemplater = raw\n\n[metadata]\nname = app\n", "[sqlfluff]\ntemplater = raw\n  [metadata]\nexclude_rules = CV05\n"],
    ["a header with text after it", "[metadata]\nname = app\n", "[metadata]\nname = app\n\n[sqlfluff] shared settings\nexclude_rules = CV05\n"],
    ["a continuation line", "[sqlfluff]\nexclude_rules = AL01,\n    ST03\n", "[sqlfluff]\nexclude_rules = AL01,\n    CV05\n"],
  ] as const) {
    it(`obeys ${label} in setup.cfg that leaves CV05 out, and the change raises the sqlfluff note`, async () => {
      expect(await run("sqlfluff", NULL_COMPARISON, "setup.cfg", base, head)).toEqual({ rules: [], notes: ["sqlfluff:setup.cfg"] });
    }, 300_000);
  }

  for (const [label, head] of [
    ["a section name in another case", "[metadata]\nname = app\n\n[SQLFluff]\nexclude_rules = CV05\n"],
    ["a header indented under an option, which configparser reads as that option's value", "[metadata]\nname = app\n  [sqlfluff]\n  exclude_rules = CV05\n"],
  ] as const) {
    it(`ignores ${label} in setup.cfg, and the change raises no note`, async () => {
      expect(await run("sqlfluff", NULL_COMPARISON, "setup.cfg", "[metadata]\nname = app\n", head)).toEqual({ rules: ["CV05"], notes: [] });
    }, 300_000);
  }

  // SQLFluff keeps option names as written, so EXCLUDE_RULES is not
  // exclude_rules. The reader compares names as written too, so a changed
  // name still raises the note: it errs towards one.
  it("reads an option name only in its own case; the reader still raises the note for it", async () => {
    expect(await run("sqlfluff", NULL_COMPARISON, "setup.cfg", "[sqlfluff]\ndialect = postgres\n", "[sqlfluff]\ndialect = postgres\nEXCLUDE_RULES = CV05\n")).toEqual({ rules: ["CV05"], notes: ["sqlfluff:setup.cfg"] });
  }, 300_000);
});
