// Real binaries on tiny planted inputs for the workflow and SQL scanners:
// zizmor, squawk and SQLFluff. Each case guards that scanner's invocation,
// output parser, changed-line filter and tool resolution together; the proxy
// cases guard that a scanner opens no connection; the settings cases guard
// what each one reads from the repository and that it writes nothing there.
// Run by the end-to-end config, not the unit config.
import { makeLineSet } from "../../../tests/line-set.mjs";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseConfig, SUPPRESSION_RULE } from "@openqodex/core";
import type { BuiltinScanner } from "@openqodex/core";
import { runScanners } from "@openqodex/scanners";
import { afterAll, describe, expect, it } from "vitest";
import { installedOnly, resolveFirst, scan, withLoggingProxy } from "./subprocess-support.js";
import type { Case } from "./subprocess-support.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

// A pull request title pasted into a script: template injection.
const INJECTED_WORKFLOW = `on: pull_request
permissions: {}
jobs:
  greet:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.pull_request.title }}"
`;

// An index built without CONCURRENTLY, which blocks writes to the table.
const BLOCKING_INDEX = "CREATE INDEX orders_customer_idx ON orders (customer_id);\n";

// A comparison with NULL by `=`, which is never true.
const NULL_COMPARISON = "SELECT id FROM users WHERE deleted_at = NULL;\n";

const cases: Case[] = [
  { scanner: "sqlfluff", rule: "CV05", files: { "reports/active_users.sql": NULL_COMPARISON }, anchor: "reports/active_users.sql" },
  { scanner: "squawk", rule: "require-concurrent-index-creation", files: { "db/migrations/0002_orders.sql": BLOCKING_INDEX }, anchor: "db/migrations/0002_orders.sql" },
  { scanner: "zizmor", rule: "template-injection", files: { ".github/workflows/greet.yml": INJECTED_WORKFLOW }, anchor: ".github/workflows/greet.yml" },
  {
    scanner: "zizmor",
    rule: "template-injection",
    files: { ".github/actions/greet/action.yml": 'name: greet\ndescription: d\nruns:\n  using: composite\n  steps:\n    - run: echo "${{ github.event.issue.title }}"\n      shell: bash\n' },
    anchor: ".github/actions/greet/action.yml",
  },
  {
    scanner: "zizmor",
    rule: "dependabot-execution",
    files: { ".github/dependabot.yml": "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily\n    cooldown:\n      default-days: 7\n    insecure-external-code-execution: allow\n" },
    anchor: ".github/dependabot.yml",
  },
];

// Every file under `dir`, relative to it, sorted.
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out.sort();
}

// A scan of `files` in a repository at `repoDir`, every line of `changed`
// counted as changed.
async function scanAt(repoDir: string, scanner: BuiltinScanner, files: Record<string, string>, changed: string[]) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repoDir, name)), { recursive: true });
    writeFileSync(join(repoDir, name), body);
  }
  const coverage = new Map(changed.map((p) => [p, makeLineSet(readFileSync(join(repoDir, p), "utf8").split("\n").map((_, i) => i + 1))]));
  return runScanners({ repoDir, changedPaths: changed, coverage, config: parseConfig("").config, resolveTool: installedOnly(), only: [scanner] });
}

let ran = 0;
let skipped = 0;
afterAll(() => {
  process.stdout.write(`${ran} ran, ${skipped} skipped\n`);
  if (process.env.CI) expect(skipped, "a builtin scanner was skipped under CI").toBe(0);
});
// Removes the temp folders this file made. Registered after any other
// after-all hook, so it runs first and a failed check still cleans up.
afterAll(removeTempDirs);

describe("workflow and SQL scanner subprocesses", () => {
  for (const spec of cases) it(`${spec.scanner} reports ${spec.rule} on a changed line of ${spec.anchor}`, async () => {
    const result = await scan(spec);
    ran++;
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: spec.scanner, ruleId: spec.rule, filePath: spec.anchor }));
  }, 300_000);

  // zizmor's template injection spans the expression alone; actionlint and
  // semgrep report the same problem on the same line (same-problem.ts).
  it("zizmor reports template injection on the expression's line, high", async () => {
    const result = await scan(cases.find((c) => c.scanner === "zizmor")!);
    const hits = result.scan.candidates.filter((c) => c.source === "zizmor" && c.ruleId === "template-injection");
    expect(hits.map((c) => [c.lineStart, c.lineEnd, c.severity])).toEqual([[7, 7, "high"]]);
  }, 300_000);

  // --offline: zizmor runs no audit that asks the GitHub API.
  it("zizmor opens no connection", async () => {
    await resolveFirst("zizmor");
    const { result, hosts } = await withLoggingProxy(() => scan(cases.find((c) => c.scanner === "zizmor")!));
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(hosts).toEqual([]);
  }, 300_000);

  // zizmor's settings hold rules only. The one at the repository root is
  // read, a change to it is a settings-file candidate, and zizmor writes
  // nothing into the repository.
  it("zizmor reads the root zizmor.yml, raises the changed settings file and writes nothing", async () => {
    const repo = tempDir("oq-adapter-zizmor-config-");
    const files = {
      ".github/workflows/greet.yml": INJECTED_WORKFLOW,
      ".github/zizmor.yml": "rules:\n  template-injection:\n    disable: true\n",
    };
    const result = await scanAt(repo, "zizmor", files, Object.keys(files));
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(result.scan.candidates.filter((c) => c.ruleId === "template-injection")).toEqual([]);
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "zizmor", ruleId: "settings-file", filePath: ".github/zizmor.yml" }));
    expect(listFiles(repo)).toEqual(Object.keys(files).sort());
  }, 300_000);

  // With no .git folder (a worktree has a .git file), zizmor itself would
  // walk up to the filesystem root for a zizmor.yml. One above the
  // repository is never read.
  it("zizmor never reads a zizmor.yml above the repository", async () => {
    const parent = tempDir("oq-adapter-zizmor-parent-");
    writeFileSync(join(parent, "zizmor.yml"), "rules:\n  template-injection:\n    disable: true\n");
    const repo = join(parent, "repo");
    mkdirSync(repo);
    const result = await scanAt(repo, "zizmor", { ".github/workflows/greet.yml": INJECTED_WORKFLOW }, [".github/workflows/greet.yml"]);
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "zizmor", ruleId: "template-injection" }));
  }, 300_000);

  it("squawk opens no connection", async () => {
    await resolveFirst("squawk");
    const { result, hosts } = await withLoggingProxy(() => scan(cases.find((c) => c.scanner === "squawk")!));
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(hosts).toEqual([]);
  }, 300_000);

  // squawk's settings hold rules and paths only. The root .squawk.toml is
  // read, a change to it is a settings-file candidate, and squawk writes
  // nothing; a file its settings leave out is nothing to check, not a failure.
  it("squawk reads the root .squawk.toml, raises the changed settings file and writes nothing", async () => {
    const repo = tempDir("oq-adapter-squawk-config-");
    const files = {
      "db/0002_orders.sql": BLOCKING_INDEX,
      "db/seed/0001_seed.sql": BLOCKING_INDEX,
      ".squawk.toml": 'excluded_rules = ["require-concurrent-index-creation"]\nexcluded_paths = ["db/seed/*"]\n',
    };
    const result = await scanAt(repo, "squawk", files, Object.keys(files));
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(result.scan.candidates.filter((c) => c.ruleId === "require-concurrent-index-creation")).toEqual([]);
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "squawk", ruleId: "settings-file", filePath: ".squawk.toml" }));
    expect(listFiles(repo)).toEqual(Object.keys(files).sort());
    const onlySeed = await scanAt(repo, "squawk", {}, ["db/seed/0001_seed.sql"]);
    expect(onlySeed.scan.scanners[0]).toMatchObject({ status: "ran", reason: null });
  }, 300_000);

  // squawk itself looks for .squawk.toml up to the filesystem root.
  it("squawk never reads a .squawk.toml above the repository", async () => {
    const parent = tempDir("oq-adapter-squawk-parent-");
    writeFileSync(join(parent, ".squawk.toml"), 'excluded_rules = ["require-concurrent-index-creation"]\n');
    const repo = join(parent, "repo");
    mkdirSync(repo);
    const result = await scanAt(repo, "squawk", { "db/0002_orders.sql": BLOCKING_INDEX }, ["db/0002_orders.sql"]);
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "squawk", ruleId: "require-concurrent-index-creation" }));
  }, 300_000);

  // squawk reads each path as a glob; unescaped, `[1]x.sql` would match
  // `1x.sql` and the changed file would go unchecked.
  it("squawk checks a changed file whose name holds glob characters, and only that file", async () => {
    const repo = tempDir("oq-adapter-squawk-glob-");
    const result = await scanAt(repo, "squawk", { "db/[1]x.sql": BLOCKING_INDEX, "db/1x.sql": "SELECT 1;\n" }, ["db/[1]x.sql"]);
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "squawk", ruleId: "require-concurrent-index-creation", filePath: "db/[1]x.sql" }));
  }, 300_000);

  it("sqlfluff opens no connection", async () => {
    await resolveFirst("sqlfluff");
    const { result, hosts } = await withLoggingProxy(() => scan(cases.find((c) => c.scanner === "sqlfluff")!));
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(hosts).toEqual([]);
  }, 300_000);

  // With SQLFluff's defaults, a .sqlfluff naming the jinja templater and a
  // library_path makes it import the library's Python files: this one would
  // write a marker outside the repo and leave bytecode inside it.
  it("sqlfluff never runs a library a repo's settings name, and writes nothing", async () => {
    const repo = tempDir("oq-adapter-sqlfluff-config-");
    const marker = join(tempDir("oq-adapter-sqlfluff-marker-"), "ran");
    const plant = `import pathlib\npathlib.Path(${JSON.stringify(marker)}).write_text("ran")\n`;
    const files = {
      ".sqlfluff": "[sqlfluff]\ntemplater = jinja\ndialect = postgres\n\n[sqlfluff:templater:jinja]\nlibrary_path = lib\n",
      "lib/__init__.py": plant,
      "lib/macros.py": plant,
      "reports/active_users.sql": NULL_COMPARISON,
    };
    const result = await scanAt(repo, "sqlfluff", files, [".sqlfluff", "reports/active_users.sql"]);
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "sqlfluff", ruleId: "CV05", filePath: "reports/active_users.sql" }));
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "sqlfluff", ruleId: "settings-file", filePath: ".sqlfluff" }));
    expect(listFiles(dirname(marker))).toEqual([]);
    expect(listFiles(repo)).toEqual(Object.keys(files).sort());
  }, 300_000);

  // The dialect comes from the repo's settings where they name one, and is
  // postgres elsewhere; a file it cannot parse gives no parse-error flood.
  it("sqlfluff reads the dialect a folder's settings name, uses postgres elsewhere, and drops parse errors", async () => {
    const repo = tempDir("oq-adapter-sqlfluff-dialect-");
    const mysql = "SELECT `id` FROM `users` WHERE `deleted_at` = NULL;\nSELECT `name` FROM `users`;\n";
    const files = {
      "mysql/.sqlfluff": "[sqlfluff]\ndialect = mysql\n",
      "mysql/active.sql": mysql,
      "pg/active.sql": NULL_COMPARISON,
      "unset/active.sql": mysql,
    };
    const result = await scanAt(repo, "sqlfluff", files, ["mysql/active.sql", "pg/active.sql", "unset/active.sql"]);
    expect(result.scan.scanners[0]).toMatchObject({ status: "ran", reason: null });
    const found = result.scan.candidates.filter((c) => c.source === "sqlfluff").map((c) => `${c.filePath}:${c.ruleId}`).sort();
    expect(found).toEqual(["mysql/active.sql:CV05", "pg/active.sql:CV05"]);
  }, 300_000);

  // SQLFluff also reads its own sections of files other tools share. A rule
  // left out there is left out of the run, so a change to such a section is
  // a settings-file candidate; the other folders still get the rule.
  it("sqlfluff reads its sections of setup.cfg, tox.ini, pep8.ini and pyproject.toml, and raises a changed one", async () => {
    const repo = tempDir("oq-adapter-sqlfluff-shared-");
    const ini = "[metadata]\nname = app\n\n[sqlfluff]\nexclude_rules = CV05\n";
    const files = {
      "a/setup.cfg": ini,
      "a/active.sql": NULL_COMPARISON,
      "b/tox.ini": ini,
      "b/active.sql": NULL_COMPARISON,
      "c/pep8.ini": ini,
      "c/active.sql": NULL_COMPARISON,
      "d/pyproject.toml": '[project]\nname = "app"\n\n[tool.sqlfluff.core]\nexclude_rules = "CV05"\n',
      "d/active.sql": NULL_COMPARISON,
      "e/active.sql": NULL_COMPARISON,
    };
    const result = await scanAt(repo, "sqlfluff", files, Object.keys(files));
    expect(result.scan.scanners[0]).toMatchObject({ status: "ran", reason: null });
    const found = result.scan.candidates.filter((c) => c.source === "sqlfluff").map((c) => `${c.filePath}:${c.ruleId}`).sort();
    expect(found).toEqual([
      "a/setup.cfg:settings-file",
      "b/tox.ini:settings-file",
      "c/pep8.ini:settings-file",
      "d/pyproject.toml:settings-file",
      "e/active.sql:CV05",
    ]);
  }, 300_000);

  // SQLFluff looks for settings in every folder from the common ancestor of
  // the file and its HOME down to the file, so a settings file above the
  // repository could leave a rule out. It runs on a copy of the repository's
  // SQL and settings files whose HOME sits beside the copy.
  it("sqlfluff never reads settings above the repository", async () => {
    const parent = tempDir("oq-adapter-sqlfluff-parent-");
    writeFileSync(join(parent, ".sqlfluff"), "[sqlfluff]\nexclude_rules = CV05\n");
    writeFileSync(join(parent, "setup.cfg"), "[sqlfluff]\nexclude_rules = CV05\n");
    const repo = join(parent, "repo");
    mkdirSync(repo);
    const result = await scanAt(repo, "sqlfluff", { "reports/active.sql": NULL_COMPARISON }, ["reports/active.sql"]);
    expect(result.scan.scanners[0]).toMatchObject({ status: "ran", reason: null });
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "sqlfluff", ruleId: "CV05", filePath: "reports/active.sql" }));
  }, 300_000);

  // A line that starts with `-- sqlfluff:` sets SQLFluff's settings for the
  // file: each of these hides or downgrades CV05 there. An added one is a
  // suppression candidate, as an added `-- noqa` is.
  it("sqlfluff obeys an inline setting, and an added one is raised as a suppression", async () => {
    const repo = tempDir("oq-adapter-sqlfluff-inline-");
    const files = {
      "a.sql": `-- sqlfluff:ignore:linting\n${NULL_COMPARISON}`,
      "b.sql": `--sqlfluff:exclude_rules:CV05\n${NULL_COMPARISON}`,
      "c.sql": `-- sqlfluff:rules:AL04\n${NULL_COMPARISON}`,
      "d.sql": `-- sqlfluff:warnings:CV05\n${NULL_COMPARISON}`,
      // A byte order mark first: SQLFluff reads past it.
      "e.sql": `\uFEFF-- sqlfluff:ignore:linting\n${NULL_COMPARISON}`,
    };
    const result = await scanAt(repo, "sqlfluff", files, Object.keys(files));
    expect(result.scan.scanners[0]).toMatchObject({ status: "ran", reason: null });
    const found = result.scan.candidates.filter((c) => c.source === "sqlfluff").map((c) => `${c.filePath}:${c.lineStart}:${c.ruleId}:${c.severity}`).sort();
    expect(found).toEqual([
      `a.sql:1:${SUPPRESSION_RULE}:medium`,
      `b.sql:1:${SUPPRESSION_RULE}:medium`,
      `c.sql:1:${SUPPRESSION_RULE}:medium`,
      "d.sql:2:CV05:info",
      `d.sql:1:${SUPPRESSION_RULE}:medium`,
      `e.sql:1:${SUPPRESSION_RULE}:medium`,
    ].sort());
  }, 300_000);

  // A review runs it on every changed .sql file; a slow start would stall it.
  it("sqlfluff checks a small file in under 10 seconds once installed", async () => {
    await resolveFirst("sqlfluff");
    const result = await scan(cases.find((c) => c.scanner === "sqlfluff")!);
    process.stdout.write(`sqlfluff on one small file: ${result.scan.scanners[0]!.durationMs} ms\n`);
    expect(result.scan.scanners[0]!.durationMs).toBeLessThan(10_000);
  }, 300_000);
});
