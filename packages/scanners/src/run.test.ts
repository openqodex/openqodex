// The runner, end to end through the real adapters. The only scanner that
// actually runs here is the in-process sqllint, on real .sql files in a temp
// directory; every other builtin is stopped at tool resolution by a real
// resolver that reports it not installed. Custom scanners are given as the
// CustomAdapter values the custom module would hand over.
//
// Failure list, written before the tests:
//   1. sqllint does not run without a resolved tool, or the resolver is
//      asked for it.
//   2. A finding on a line the change did not touch survives.
//   3. Candidate ids are not c1, c2, ... in severity order, the token is not
//      "<source>:<ruleId>", or reviewSeverity is not the mapped scale.
//   4. The resolver is asked for a scanner whose files are not in the change.
//   5. A scanner the resolver reports not installed (or failed, or
//      installing) is missing from the summaries, has the wrong status or
//      no reason, or makes runScanners reject.
//   6. A resolver or a custom scanner that throws makes runScanners reject.
//   7. A scanner in config.disabledScanners runs, or is resolved, or has no
//      "disabled" row.
//   8. `only` and `skip` are ignored.
//   9. A finding in a fixture folder survives without include_fixtures, or
//      is dropped with it.
//  10. A rule matched by disabled_rules survives.
//  11. A matched secret appears in a candidate message, or the fingerprints
//      are missing.
//  12. A custom scanner marked skipped is run, or its row is lost.
//  13. A custom scanner's findings skip the pipeline (changed-line filter,
//      dedup, sort) or come before the builtins'.
//  14. onProgress does not get one line per scanner.
//  15. An absolute path a scanner prints, through a symlinked directory, is
//      not rebased onto the repo root (toRunDirRelative).
//  16. With OPENQODEX_OFFLINE=1, osv-scanner is resolved or started (it
//      would send dependency names to osv.dev), or is not recorded as
//      disabled with its plain reason.
//  17. A scanner's error text carries a matched secret into its saved reason
//      or a progress line.
//  18. A message or reason cut short ends in the first part of a secret, or
//      starts with the last part of one, which full-string redaction misses.
//  19. Two different rules from one scanner on one span collapse into one.
//  20. A changed file named "-app.sh" is never scanned.
//  22. With OPENQODEX_OFFLINE=1, semgrep is resolved or started and fetches
//      its registry rule packs.
//  21. A .sql path that is a symlink to /dev/zero or a FIFO hangs the run;
//      one that leads out of the repo is read; an oversized one is read.
// Added for suppression comments a change adds:
//  23. An added suppression comment yields no candidate when its scanner is
//      not installed, or the candidate names the wrong scanner, rule, line
//      or severity.
//  24. A marker on a line the change did not add yields a candidate.
//  25. A marker in a file its scanner does not check yields a candidate.
//  26. A scanner finding on the same line swallows a suppression or a
//      settings candidate in the cross-scanner dedup.
//  27. A scanner left out with only or skip for one run loses its suppression
//      and settings candidates, though the comment or the file still
//      silences it in every other run; or a scanner switched off with
//      scanners.disable keeps them.
//  28. A whole-repository run, which has no added lines, yields one.
//  29. The candidate's message carries text from the line, such as a secret.
// Added after the code review of the second version:
//  30. The fixture filter drops a changed settings file in a fixture folder,
//      though a config outside it can extend that file and hide findings
//      the report shows (ruff's extend, checked with ruff 0.8.4).
//  31. A suppression comment in a fixture file survives the fixture filter;
//      it only silences findings in its own file, which the filter hides.
//  32. A file over 5 MB is not read, though bandit and the others scan it;
//      or a file semgrep skips for its size still raises a semgrep candidate.
//  33. A file under semgrep's size limit loses its semgrep candidate because
//      its text, decoded, is longer than the file (invalid UTF-8).
//  34. Keeping changed settings files out of the fixture filter takes time
//      that grows with the square of their number; or many thousands of
//      such candidates overflow the call stack and the scan throws.
//  35. A settings file with many thousands of changed lines overflows the
//      call stack while its first changed line is found.
// Added for issue #89, candidate order:
//  36. Candidate ids depend on the order a scanner prints its findings, so
//      one change gets other ids on another run or machine (checkov on Linux
//      prints its framework reports in the order they finish); or ties in
//      severity are not ordered by scanner, file, line start, line end and
//      rule id.
//  37. Of two hits a scanner repeats with one rule on one span, the one kept
//      depends on the order they were printed.
// Added after the code review of the library branch:
//  38. Of two hits a scanner repeats with one rule on one span, the one kept
//      is the lower severity one because its message sorts first, so the
//      candidate's severity drops (and with it a block).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REDACTED } from "@openqodex/core";
import type {
  BuiltinScanner,
  Config,
  ResolveTool,
  StaticFinding,
} from "@openqodex/core";
import { parseCheckovJson } from "./adapters/checkov.js";
import { runScanners, toRunDirRelative } from "./run.js";
import type { CustomAdapter } from "./run.js";

const SQL = [
  "create or replace function public.admin_get_users() returns setof users", // 1: admin, no revoke (high)
  "language sql security definer", // 2: definer without search_path (high)
  "as $$ select * from users $$;", // 3
  "comment on function admin_get_users() is 'list users';", // 4: unqualified comment (low)
  "",
].join("\n");

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openqodex-run-"));
  roots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function config(over: Partial<Config> = {}): Config {
  return {
    blockOnSeverity: null,
    severityThreshold: "info",
    defaultBase: null,
    graph: { enabled: true, budgetMs: 10_000, maxFiles: 4000, maxFileBytes: 512 * 1024, maxCacheMb: 512, maxHeapMb: 1536 },
    exclude: [],
    disabledRules: [],
    includeFixtures: false,
    disabledScanners: [],
    custom: [],
    ...over,
  };
}

function lines(...ns: number[]): Set<number> {
  return new Set(ns);
}

// A real resolver: nothing is installed on this imaginary machine. It
// records what it was asked for.
function notInstalled(asked: BuiltinScanner[] = []): ResolveTool {
  return async (scanner) => {
    asked.push(scanner);
    return { ok: false, status: "not_installed", reason: `${scanner} is not installed` };
  };
}

function finding(over: Partial<StaticFinding>): StaticFinding {
  return {
    source: "custom:demo",
    ruleId: "rule",
    filePath: "db/migrate.sql",
    lineStart: 1,
    lineEnd: 1,
    severity: "medium",
    message: "msg",
    reference: null,
    ...over,
  };
}

function custom(over: Partial<CustomAdapter> & Pick<CustomAdapter, "run">): CustomAdapter {
  return { source: "custom:demo", skipped: null, wants: () => true, ...over };
}

describe("runScanners", () => {
  it("redacts matched secrets from every candidate and keeps only fingerprints (11)", async () => {
    // Built at run time so this file holds no secret-shaped literal.
    const secret = ["sk", "live", "Zq8Xk2Lm9Pq4Rs7Tv1Wx3Yz5"].join("_");
    const dir = repo({ "app/config.py": `KEY = "${secret}"\n` });
    const { scan, secrets } = await runScanners({
      repoDir: dir,
      changedPaths: ["app/config.py"],
      coverage: new Map([["app/config.py", lines(1)]]),
      config: config(),
      resolveTool: notInstalled(),
      custom: [
        custom({
          source: "custom:secrets",
          run: async () => ({
            findings: [
              finding({
                source: "custom:secrets",
                ruleId: "key",
                filePath: "app/config.py",
                severity: "high",
                message: `found ${secret} on line 1`,
              }),
            ],
            error: null,
            secrets: [secret],
            version: "1.0.0",
          }),
        }),
      ],
    });
    expect(secrets).toEqual([secret]);
    expect(JSON.stringify(scan)).not.toContain(secret);
    expect(scan.candidates[0]?.message).toBe(`found ${REDACTED} on line 1`);
    expect(scan.secretFingerprints).toEqual([{ length: secret.length, sha256: expect.any(String) }]);
    expect(scan.scanners.find((s) => s.scanner === "custom:secrets")).toMatchObject({ status: "ran", version: "1.0.0" });
  });
});

describe("secrets in reasons and cut text", () => {
  const secret = ["sk", "live", "Zq8Xk2Lm9Pq4Rs7Tv1Wx3Yz5Ab6Cd0Ef"].join("_");
  const holder = (): CustomAdapter =>
    custom({
      source: "custom:holder",
      run: async () => ({ findings: [], error: null, secrets: [secret], version: null }),
    });

  it("redacts a secret from another scanner's error and never prints it (17)", async () => {
    const dir = repo({ "a.txt": "x\n" });
    const progress: string[] = [];
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["a.txt"],
      coverage: new Map([["a.txt", lines(1)]]),
      config: config(),
      resolveTool: notInstalled(),
      only: ["custom:holder", "custom:leaky"],
      onProgress: (line) => progress.push(line),
      custom: [
        holder(),
        custom({
          source: "custom:leaky",
          run: async () => ({ findings: [], error: `bad input ${secret} here`, version: null }),
        }),
      ],
    });
    expect(JSON.stringify(scan)).not.toContain(secret);
    expect(progress.join("\n")).not.toContain(secret);
    expect(progress.join("\n")).not.toContain("bad input");
    expect(scan.scanners.find((s) => s.scanner === "custom:leaky")?.reason).toBe(`bad input ${REDACTED} here`);
  });

  it("redacts a secret cut at the end of a message or the start of a reason (18)", async () => {
    const dir = repo({ "a.txt": "x\n" });
    const cut = `${"word ".repeat(95)}${secret.slice(0, 20)}...`;
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["a.txt"],
      coverage: new Map([["a.txt", lines(1)]]),
      config: config(),
      resolveTool: notInstalled(),
      only: ["custom:holder", "custom:cut"],
      custom: [
        holder(),
        custom({
          source: "custom:cut",
          run: async () => ({
            findings: [finding({ source: "custom:cut", filePath: "a.txt", message: cut })],
            error: `${secret.slice(-12)} was rejected`,
            version: null,
          }),
        }),
      ],
    });
    const message = scan.candidates[0]?.message ?? "";
    expect(message).not.toContain(secret.slice(0, 6));
    expect(message.endsWith(`${REDACTED}...`)).toBe(true);
    const reason = scan.scanners.find((s) => s.scanner === "custom:cut")?.reason ?? "";
    expect(reason).not.toContain(secret.slice(-6));
    expect(reason).toBe(`${REDACTED} was rejected`);
  });
});

// Kept through the unit test prune: the dedup fix for failure 38 rewrote the
// loop that keeps one hit per rule, and this is the case that two rules of
// one scanner on one span both stay.
describe("dedup across scanners only", () => {
  it("keeps two rules from one scanner on one span, merges the same class across scanners (19)", async () => {
    const dir = repo({ "app.py": "x\n" });
    const at = { filePath: "app.py", lineStart: 1, lineEnd: 1, severity: "high" as const };
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["app.py"],
      coverage: new Map([["app.py", lines(1)]]),
      config: config(),
      resolveTool: notInstalled(),
      only: ["custom:a", "custom:b"],
      custom: [
        custom({
          source: "custom:a",
          run: async () => ({
            findings: [
              finding({ ...at, source: "custom:a", ruleId: "sql-injection" }),
              finding({ ...at, source: "custom:a", ruleId: "command-injection" }),
            ],
            error: null,
            version: null,
          }),
        }),
        custom({
          source: "custom:b",
          run: async () => ({
            findings: [finding({ ...at, source: "custom:b", ruleId: "tainted-sql-string" })],
            error: null,
            version: null,
          }),
        }),
      ],
    });
    expect(scan.candidates.map((c) => c.token)).toEqual(["custom:a:command-injection", "custom:a:sql-injection"]);
  });
});

describe("suppression comments the change adds", () => {
  const PY = "import os\nsubprocess.call(cmd, shell=True)  # nosec\n";

  it("raises one candidate per added marker while its scanner is not installed (23)", async () => {
    const dir = repo({ "app.py": PY });
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["app.py"],
      coverage: new Map([["app.py", lines(1, 2)]]),
      config: config(),
      resolveTool: notInstalled(),
    });
    expect(scan.candidates.map((c) => [c.token, c.filePath, c.lineStart, c.lineEnd, c.reviewSeverity])).toEqual([
      ["bandit:openqodex.suppression-added", "app.py", 2, 2, "minor"],
    ]);
    expect(scan.scanners.find((s) => s.scanner === "bandit")).toMatchObject({ status: "not_installed", keptCount: 1 });
  });

  it("keeps them through only and skip, and leaves out a scanner scanners.disable switches off (27)", async () => {
    const dir = repo({ "app.py": "x = 1  # nosec  # noqa\n", ".gitleaksignore": "x\n" });
    const tokens = async (over: { only?: BuiltinScanner[]; skip?: BuiltinScanner[]; disabledScanners?: BuiltinScanner[] }) => {
      const { scan } = await runScanners({
        repoDir: dir,
        changedPaths: ["app.py", ".gitleaksignore"],
        coverage: new Map([
          ["app.py", lines(1)],
          [".gitleaksignore", lines(1)],
        ]),
        config: config({ disabledScanners: over.disabledScanners ?? [] }),
        resolveTool: notInstalled(),
        only: over.only,
        skip: over.skip,
      });
      return scan.candidates.map((c) => c.token).sort();
    };
    const all = ["bandit:openqodex.suppression-added", "gitleaks:settings-file", "ruff:openqodex.suppression-added"];
    expect(await tokens({})).toEqual(all);
    expect(await tokens({ skip: ["bandit", "gitleaks"] })).toEqual(all);
    expect(await tokens({ only: ["sqllint"] })).toEqual(all);
    expect(await tokens({ disabledScanners: ["ruff", "gitleaks"] })).toEqual(["bandit:openqodex.suppression-added"]);
  });

  it("keeps a changed settings file in a fixture folder, and drops a suppression comment in a fixture file (30, 31)", async () => {
    const dir = repo({ "fixtures/ruff.toml": "[lint]\nignore = [\"E401\"]\n", "testdata/app.py": "x = 1  # nosec\n" });
    const tokens = async (includeFixtures: boolean) => {
      const { scan } = await runScanners({
        repoDir: dir,
        changedPaths: ["fixtures/ruff.toml", "testdata/app.py"],
        coverage: new Map([
          ["fixtures/ruff.toml", lines(1, 2)],
          ["testdata/app.py", lines(1)],
        ]),
        config: config({ includeFixtures }),
        resolveTool: notInstalled(),
      });
      return scan.candidates.map((c) => `${c.token} ${c.filePath}`).sort();
    };
    expect(await tokens(false)).toEqual(["ruff:settings-file fixtures/ruff.toml"]);
    expect(await tokens(true)).toEqual(["bandit:openqodex.suppression-added testdata/app.py", "ruff:settings-file fixtures/ruff.toml"]);
  });

  it("reads a file over 5 MB, and skips semgrep's marker in a file semgrep skips for its size (32)", async () => {
    const big = `x = 1  # nosec nosemgrep\n${"# pad\n".repeat(1_000_000)}`;
    const dir = repo({ "big.py": big });
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["big.py"],
      coverage: new Map([["big.py", lines(1)]]),
      config: config(),
      resolveTool: notInstalled(),
    });
    expect(scan.candidates.map((c) => c.token)).toEqual(["bandit:openqodex.suppression-added"]);
  }, 20_000);

  it("measures semgrep's size limit on the file, not on its decoded text (33)", async () => {
    const dir = repo({});
    // 400,000 bytes that are not UTF-8 decode to 1,200,000 bytes of U+FFFD.
    fs.writeFileSync(path.join(dir, "data.py"), Buffer.concat([Buffer.from("x = 1  # nosemgrep\n# "), Buffer.alloc(400_000, 0xff), Buffer.from("\n")]));
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["data.py"],
      coverage: new Map([["data.py", lines(1)]]),
      config: config(),
      resolveTool: notInstalled(),
    });
    expect(scan.candidates.map((c) => c.token)).toEqual(["semgrep:openqodex.suppression-added"]);
  });

  it("keeps changed settings files out of the fixture filter in linear time (34)", async () => {
    // As many scanner findings as settings candidates, so each finding is
    // checked against every settings candidate when the check is a list scan.
    const dir = repo({});
    const time = async (n: number) => {
      const changed = Array.from({ length: n }, (_, k) => `d${k}/ruff.toml`);
      const hits = changed.map((p) => finding({ source: "custom:many", ruleId: "hit", filePath: p, lineStart: 1, lineEnd: 1 }));
      const started = performance.now();
      const { scan } = await runScanners({
        repoDir: dir,
        changedPaths: changed,
        coverage: new Map(changed.map((p) => [p, lines(1)])),
        config: config({ disabledScanners: ["semgrep", "gitleaks"] }),
        resolveTool: notInstalled(),
        only: ["ruff", "custom:many"],
        custom: [custom({ source: "custom:many", run: async () => ({ findings: hits, error: null, version: null }) })],
      });
      expect(scan.candidates).toHaveLength(2 * n);
      return performance.now() - started;
    };
    await time(20_000);
    const small = await time(25_000);
    const large = await time(200_000);
    // Eight times the input: linear work takes about eight times as long,
    // square work about sixty-four times.
    expect(large / small).toBeLessThan(24);
  }, 300_000);

  it("raises the settings candidate of a file with 200,000 changed lines on its first one (35)", async () => {
    const dir = repo({});
    const many = new Set(Array.from({ length: 200_000 }, (_, k) => 200_000 - k));
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: [".gitleaksignore"],
      coverage: new Map([[".gitleaksignore", many]]),
      config: config(),
      resolveTool: notInstalled(),
      only: ["gitleaks"],
    });
    expect(scan.candidates.map((c) => `${c.token} ${c.lineStart}`)).toEqual(["gitleaks:settings-file 1"]);
  });

  it("names the marker and the scanner, never the line's text (29)", async () => {
    const secret = ["sk", "live", "Zq8Xk2Lm9Pq4Rs7Tv1Wx3Yz5"].join("_");
    const dir = repo({ "app/config.py": `KEY = "${secret}"  # gitleaks:allow\n` });
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["app/config.py"],
      coverage: new Map([["app/config.py", lines(1)]]),
      config: config(),
      resolveTool: notInstalled(),
    });
    expect(scan.candidates.map((c) => c.message)).toEqual([
      "This change adds gitleaks:allow, which stops gitleaks reporting what it covers; check that it hides no real problem",
    ]);
    expect(JSON.stringify(scan)).not.toContain(secret);
  });
});

describe("files the change can use against the scan", () => {
  it("scans a file whose name starts with a dash (20)", async () => {
    const dir = repo({ "-app.sh": "echo $1\n" });
    const asked: BuiltinScanner[] = [];
    await runScanners({
      repoDir: dir,
      changedPaths: ["-app.sh"],
      coverage: new Map([["-app.sh", lines(1)]]),
      config: config(),
      resolveTool: notInstalled(asked),
    });
    expect(asked).toContain("shellcheck");
  });

  it("refuses device, FIFO, outside and oversized .sql files without hanging (21)", async () => {
    const outside = repo({ "secret.sql": SQL });
    const dir = repo({ "good.sql": SQL, "big.sql": `${SQL}${"-- pad\n".repeat(800_000)}` });
    fs.symlinkSync("/dev/zero", path.join(dir, "zero.sql"));
    fs.symlinkSync(path.join(outside, "secret.sql"), path.join(dir, "out.sql"));
    fs.symlinkSync(outside, path.join(dir, "linked"));
    execFileSync("mkfifo", [path.join(dir, "pipe.sql")]);
    const changed = ["good.sql", "zero.sql", "pipe.sql", "out.sql", "linked/secret.sql", "big.sql"];
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: changed,
      coverage: new Map(changed.map((p) => [p, lines(1, 2, 3, 4)])),
      config: config(),
      resolveTool: notInstalled(),
      only: ["sqllint"],
    });
    expect(new Set(scan.candidates.map((c) => c.filePath))).toEqual(new Set(["good.sql"]));
    const reason = scan.scanners[0]?.reason ?? "";
    expect(reason).toContain("zero.sql: not a regular file");
    expect(reason).toContain("pipe.sql: not a regular file");
    expect(reason).toContain("linked/secret.sql: outside the repo");
    expect(reason).toContain("big.sql: larger than");
  }, 10_000);
});

// Copied from the source product's path round-trip tests.
describe("toRunDirRelative", () => {
  function ruffFinding(filePath: string): StaticFinding {
    return finding({ source: "ruff", ruleId: "S602", filePath, lineStart: 3, lineEnd: 3, severity: "high" });
  }

  it("rebases a path printed through the resolved side of a symlinked run directory (15)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "openqodex-rebase-"));
    roots.push(base);
    const real = path.join(base, "real");
    const link = path.join(base, "link");
    fs.mkdirSync(path.join(real, "app"), { recursive: true });
    fs.symlinkSync(real, link);
    const printed = path.join(fs.realpathSync(real), "app", "main.py");
    expect(toRunDirRelative([ruffFinding(printed)], link)[0].filePath).toBe("app/main.py");
  });
});

// ruff reads [tool.ruff] of pyproject.toml, and [project] requires-python
// beside it as its target version; SQLFluff reads [tool.sqlfluff] there and
// its [sqlfluff] sections of setup.cfg, tox.ini and pep8.ini. Those files
// belong to other tools too, so one counts as a settings file only when the
// change alters what the scanner reads from it, by meaning: TOML as a TOML
// parser reads it, INI as Python's configparser reads it for SQLFluff.
describe("a settings file other tools share counts when what the scanner reads from it changed", () => {
  const notes = async (file: string, base: string | null, head: string | null, changed: number[]) => {
    const files: Record<string, string> = { "db/report.sql": "SELECT 1;\n", "app/main.py": "import os\n" };
    if (head !== null) files[file] = head;
    const dir = repo(files);
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["db/report.sql", "app/main.py", file],
      coverage: new Map([
        ["db/report.sql", lines(1)],
        ["app/main.py", lines(1)],
        [file, lines(...changed)],
      ]),
      baseText: async (p) => (p === file ? base : null),
      config: config(),
      resolveTool: notInstalled(),
    });
    return scan.candidates.filter((c) => c.ruleId === "settings-file").map((c) => c.token);
  };
  const PROJECT = '[project]\nname = "app"\n';

  it("raises the note for a file it cannot read: a duplicate section, a line with no =, a deleted file that held settings, broken TOML", async () => {
    const base = "[sqlfluff]\ndialect = postgres\n";
    expect(await notes("setup.cfg", base, `${base}\n[sqlfluff]\nexclude_rules = CV05\n`, [3, 4, 5])).toEqual(["sqlfluff:settings-file"]);
    expect(await notes("setup.cfg", base, `${base}exclude_rules CV05\n`, [3])).toEqual(["sqlfluff:settings-file"]);
    expect(await notes("tox.ini", base, null, [])).toEqual(["sqlfluff:settings-file"]);
    expect(await notes("pyproject.toml", `${PROJECT}\n[tool.ruff]\nline-length = 100\n`, `${PROJECT}\n[tool.ruff\nline-length = 100\n`, [4])).toEqual(["sqlfluff:settings-file", "ruff:settings-file"]);
  });
});

describe("candidate order", () => {
  // Checkov's own report for test/fixtures/trivy/repo: one list of failed
  // checks per framework (terraform, cloudformation, kubernetes).
  const report = JSON.parse(fs.readFileSync(new URL("../test/fixtures/checkov/report.json", import.meta.url), "utf8")) as { check_type: string; results: { failed_checks: unknown[] } }[];
  const files = { "infra/main.tf": "x\n", "cfn/stack.yaml": "x\n", "k8s/pod.yaml": "x\n" };
  const scan = async (printed: typeof report) => {
    const findings = parseCheckovJson(JSON.stringify(printed), "3.3.22").map((f) => ({ ...f, source: "custom:checkov" as const }));
    const { scan: result } = await runScanners({
      repoDir: repo(files),
      changedPaths: Object.keys(files),
      config: config(),
      resolveTool: notInstalled(),
      only: ["custom:checkov"],
      custom: [custom({ source: "custom:checkov", run: async () => ({ findings, error: null, version: null }) })],
    });
    return result.candidates.map((c) => [c.id, c.ruleId, c.filePath, c.lineStart, c.lineEnd, c.message]);
  };

  it("gives the same ids whatever order the scanner printed its findings in (36)", async () => {
    const printed = await scan(report);
    expect(printed).toHaveLength(30);
    // The framework reports in the order Linux's checkov may finish them.
    expect(await scan([...report].reverse())).toEqual(printed);
    // Every list printed backwards, and the frameworks interleaved.
    expect(await scan(report.map((r) => ({ ...r, results: { ...r.results, failed_checks: [...r.results.failed_checks].reverse() } })).reverse())).toEqual(printed);
    // One severity here, so the order is file, line start, line end, rule id.
    const key = (c: (typeof printed)[number]) => [c[2], c[3], c[4], c[1]] as [string, number, number, string];
    const sorted = [...printed].sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
      return 0;
    });
    expect(printed.map((c) => c[0])).toEqual(printed.map((_, i) => `c${i + 1}`));
    expect(printed).toEqual(sorted);
  });

  it("keeps the same one of two hits a scanner repeats with one rule on one span (37)", async () => {
    const dir = repo({ "a.sh": "x\n" });
    const twice = (messages: string[]) =>
      runScanners({
        repoDir: dir,
        changedPaths: ["a.sh"],
        config: config(),
        resolveTool: notInstalled(),
        only: ["custom:demo"],
        custom: [custom({ run: async () => ({ findings: messages.map((message) => finding({ filePath: "a.sh", message })), error: null, version: null }) })],
      }).then((r) => r.scan.candidates.map((c) => c.message));
    expect(await twice(["second wording", "first wording"])).toEqual(["first wording"]);
    expect(await twice(["first wording", "second wording"])).toEqual(["first wording"]);
  });

  it("keeps the higher severity of two hits a scanner repeats with one rule on one span, whatever their messages (38)", async () => {
    const dir = repo({ "a.sh": "x\n" });
    const twice = (hits: Partial<StaticFinding>[]) =>
      runScanners({
        repoDir: dir,
        changedPaths: ["a.sh"],
        config: config(),
        resolveTool: notInstalled(),
        only: ["custom:demo"],
        custom: [custom({ run: async () => ({ findings: hits.map((h) => finding({ filePath: "a.sh", ...h })), error: null, version: null }) })],
      }).then((r) => r.scan.candidates.map((c) => [c.severity, c.message]));
    const high = { severity: "high" as const, message: "Z: the serious wording" };
    const low = { severity: "low" as const, message: "A: the mild wording" };
    expect(await twice([high, low])).toEqual([["high", "Z: the serious wording"]]);
    expect(await twice([low, high])).toEqual([["high", "Z: the serious wording"]]);
  });
});
