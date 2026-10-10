// The CLI commands, run as real subprocesses of the built dist/bin.js in real
// temp git repos. Build first (`pnpm build`). No scanner is installed:
// OPENQODEX_HOME points at an empty temp folder and --no-install is passed,
// so every scanner the change needs is reported as not installed and the run
// has zero candidates. Which findings the scanners report belongs to the
// end-to-end tests. Temp folders are left to the system's temp cleanup.
//
// Ways these commands could fail, written before the code:
// 1. An unknown flag, a flag missing its value or a bad --format value runs
//    anyway, or exits with something other than 2.
// 2. Outside a git repository a command crashes with a stack, or exits 0.
// 3. An empty change scans, writes a report or exits non-zero.
// 4. review --agent changes `git status --porcelain` (writes outside the
//    self-ignored .openqodex/), or does not write the brief, manifest, scan,
//    candidate list and latest.json.
// 5. review --finalize accepts a submission for a different change id, or
//    invalid JSON, or a submission that breaks the schema, or a run whose
//    files changed since the brief, or a config that changed since the
//    brief, and writes a report anyway.
// 6. A finding on a file outside the change counts toward the verdict
//    instead of landing in "Outside the changed lines".
// 7. block_on_severity is ignored, so a critical finding exits 0, or the
//    verdict blocks without it.
// 8. A finalize with no brief, or with no findings file, crashes or exits
//    other than 2 without saying what to run.
// 9. guide finds its files from the current directory, so it fails from an
//    installed package or another folder; an unknown topic exits 0.
// 10. demo writes into a non-empty folder, commits the planted change,
//     ships a fixed secret, or needs the user's git identity.
// Added after the review round:
// 11. finalize with a path picks a newer run of the same change instead of
//     the run whose folder holds the findings file.
// 12. finalize follows a traversal in latest.json or a symbolic link and
//     reads or writes outside the repo's .openqodex/reviews/.
// 13. scan leaves a copy of the diff (change.diff) in the report folder.
// 14. a matched secret that also sits in another stored string (a file
//     name) is written to scan.json or candidates.json.
// 15. the hidden install worker takes any name, so a path like ../../x
//     reaches the home folder, and a worker failure exits 1.
// 16. demo's commit lands in the repo an inherited GIT_DIR points to.
// 17. --output writes through a symbolic link and truncates its target.
// 18. doctor --install installs while --offline or --no-install is given.
// 19. doctor exits 0 for a --config or --cwd that does not exist.
// 20. --only constructor or --only=, selects nothing and passes.
// 21. the finalize command in the brief drops --cwd or --config, or breaks
//     on a path with a space or a quote.
// 22. demo accepts a flag it ignores, such as --config.
// 23. doctor --install in a repository installs scanners its files do not
//     call for (brakeman in a TypeScript repo) or ones its config switches
//     off; outside a repository, or with --all-scanners, it installs less
//     than every scanner; --all-scanners is taken without --install, or
//     --require-all without --install --all-scanners.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(cliRoot, "dist", "bin.js");
let home = "";

function temp(prefix: string): string {
  const dir = tempDir(`oq-cli-${prefix}-`);
  return dir;
}

type Result = { code: number | null; stdout: string; stderr: string };

// The test runner sets FORCE_COLOR; the CLI is run as a user would run it.
function cliEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENQODEX_HOME: home, NO_COLOR: "1", ...extra };
  delete env.FORCE_COLOR;
  return env;
}

function cli(args: string[], cwd: string, env: Record<string, string> = {}): Result {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: cliEnv(env),
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
}

function status(cwd: string): string {
  return git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
}

// A repo with one commit and an uncommitted change to app.py (lines 2 and 3)
// plus one untracked file.
function repoWithChange(config?: string): string {
  const dir = temp("repo");
  git(dir, ["init", "--quiet", "-b", "main"]);
  writeFileSync(join(dir, "app.py"), "def a():\n    return 1\n");
  writeFileSync(join(dir, "other.py"), "x = 1\n");
  if (config !== undefined) writeFileSync(join(dir, ".openqodex.yaml"), config);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "base"]);
  writeFileSync(join(dir, "app.py"), "def a():\n    return 2\n\ndef b():\n    return 3\n");
  writeFileSync(join(dir, "new.py"), "y = 2\n");
  return dir;
}

// The newest review's folder, or with `receipt` "latest-scan.json" the newest scan's.
function latestDir(repo: string, receipt = "latest.json"): string {
  const latest = JSON.parse(readFileSync(join(repo, ".openqodex", receipt), "utf8")) as { dir: string };
  return join(repo, latest.dir);
}

function brief(repo: string): { dir: string; changeId: string } {
  const r = cli(["review", "--agent", "--no-install"], repo);
  expect(r.stderr).not.toContain("openqodex failed");
  expect(r.code).toBe(0);
  const dir = latestDir(repo);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { change_id: string };
  return { dir, changeId: manifest.change_id };
}

function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "major",
    category: "bug",
    confidence: 0.9,
    file_path: "app.py",
    line_number: 2,
    title: "Returns the wrong value",
    description: "a() now returns 2.",
    suggested_change: null,
    source: null,
    ...over,
  };
}

function submit(dir: string, changeId: string, findings: unknown[], extra: Record<string, unknown> = {}): void {
  const body = { version: 1, change_id: changeId, summary: "Checked.", reviewer: "subagent", findings, ...extra };
  writeFileSync(join(dir, "agent-findings.json"), JSON.stringify(body));
}

beforeAll(() => {
  if (!existsSync(BIN)) throw new Error(`build first: ${BIN} is missing`);
  home = temp("home");
});

describe("frame", () => {
  it("a bad flag or value runs anyway instead of exiting 2 with one line", () => {
    const repo = repoWithChange();
    for (const args of [["scan", "--bogus"], ["scan", "--base"], ["review", "--format", "xml"], ["doctor", "extra"]]) {
      const r = cli(args, repo);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
      expect(r.stdout).toBe("");
    }
  });

  it("outside a git repository the command exits 0 or crashes", () => {
    const r = cli(["scan", "--no-install"], temp("plain"));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not a git repository");
  });

  it("an empty change scans, writes run state or exits non-zero", () => {
    const repo = repoWithChange();
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "--quiet", "-m", "all"]);
    for (const cmd of [["scan"], ["review", "--agent"], ["review"]]) {
      const r = cli([...cmd, "--no-install", "--uncommitted"], repo);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("Nothing to review: no changes against HEAD");
    }
    // Only the team files a first run creates; no report, no receipt.
    expect(readdirSync(join(repo, ".openqodex")).sort()).toEqual([".gitignore", "config.yaml", "custom-instructions.md"]);
  });
});

describe("review --agent and --finalize", () => {
  it("a findings file outside a report folder is accepted", () => {
    const repo = repoWithChange();
    const { dir, changeId } = brief(repo);
    const elsewhere = join(temp("findings"), "findings.json");
    writeFileSync(elsewhere, JSON.stringify({ version: 1, change_id: changeId, summary: "ok", findings: [] }));
    const r = cli(["review", "--finalize", elsewhere], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not in a report folder");
    expect(existsSync(join(dir, "report.json"))).toBe(false);
  });

  it("finalize follows a traversal in latest.json or a symbolic link out of the repo", () => {
    const repo = repoWithChange();
    const { dir, changeId } = brief(repo);
    submit(dir, changeId, []);
    const outside = join(temp("outside"), "run");
    cpSync(dir, outside, { recursive: true });

    // latest.json pointing out of the repo
    const latestPath = join(repo, ".openqodex", "latest.json");
    const latest = JSON.parse(readFileSync(latestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(latestPath, JSON.stringify({ ...latest, dir: `../../../../../../../..${outside}` }));
    let r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(existsSync(join(outside, "report.json"))).toBe(false);
    writeFileSync(latestPath, JSON.stringify(latest));

    // the run folder replaced by a link to a folder outside the repo
    renameSync(dir, `${dir}-moved`);
    symlinkSync(outside, dir);
    r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("symbolic link");
    expect(existsSync(join(outside, "report.json"))).toBe(false);
  });

  it("a symbolic link as the findings file is read", () => {
    const repo = repoWithChange();
    const { dir, changeId } = brief(repo);
    const real = join(temp("real"), "f.json");
    writeFileSync(real, JSON.stringify({ version: 1, change_id: changeId, summary: "ok", findings: [] }));
    symlinkSync(real, join(dir, "agent-findings.json"));
    const r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("symbolic link");
  });

  it("the finalize command in the brief drops --cwd or --config, or breaks on a quote in a path", () => {
    const repo = repoWithChange();
    const cfgDir = join(temp("cfg"), "it's here");
    mkdirSync(cfgDir);
    const cfg = join(cfgDir, "policy.yaml");
    writeFileSync(cfg, "version: 1\nreview:\n  block_on_severity: critical\n");
    const r = cli(["review", "--agent", "--no-install", "--config", cfg], repo);
    expect(r.code).toBe(0);
    // A local build names its own node and entry file.
    const command = /`([^`]* review --finalize [^`]+)`/.exec(r.stdout)?.[1];
    expect(command).toBeDefined();
    const dir = latestDir(repo);
    const changeId = (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { change_id: string }).change_id;
    submit(dir, changeId, [finding({ severity: "critical" })]);
    // Run it the way an agent would, through a shell, from another folder,
    // as the brief printed it.
    const line = command as string;
    const run = spawnSync("sh", ["-c", line], { cwd: temp("other"), encoding: "utf8", env: cliEnv({}) });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(1);
  });

  it("a wrong change id, invalid JSON or a schema error still writes a report", () => {
    const repo = repoWithChange();
    const { dir, changeId } = brief(repo);

    submit(dir, "0123456789ab", [finding()]);
    let r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("the change moved");

    writeFileSync(join(dir, "agent-findings.json"), "{ not json");
    r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not valid JSON");

    submit(dir, changeId, [finding({ severity: "huge" })]);
    r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("findings[0].severity");

    expect(existsSync(join(dir, "report.json"))).toBe(false);
  });

  it("a config changed after the brief still finalizes", () => {
    const repo = repoWithChange();
    const { dir, changeId } = brief(repo);
    // The first brief created .openqodex/config.yaml, the file now in use.
    writeFileSync(join(repo, ".openqodex/config.yaml"), "version: 1\nreview:\n  block_on_severity: major\n");
    submit(dir, changeId, [finding()]);
    const r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("config changed");
    expect(existsSync(join(dir, "report.json"))).toBe(false);
  });

  it("block_on_severity is ignored or blocks below the threshold", () => {
    const repo = repoWithChange("version: 1\nreview:\n  block_on_severity: critical\n");
    const { dir, changeId } = brief(repo);
    submit(dir, changeId, [finding({ severity: "major" })]);
    expect(cli(["review", "--finalize"], repo).code).toBe(0);
    submit(dir, changeId, [finding({ severity: "critical" })]);
    const r = cli(["review", "--finalize", "--format", "json"], repo);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stdout) as { verdict: string }).verdict).toBe("blocked");
  });

  it("finalize with no brief or no findings file crashes instead of naming the step", () => {
    const repo = repoWithChange();
    let r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("review --agent");
    brief(repo);
    r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("agent-findings.json");
  });
});

describe("scan", () => {
  it("scan leaves a copy of the diff in the report folder", () => {
    const repo = repoWithChange();
    expect(cli(["scan", "--no-install"], repo).code).toBe(0);
    expect(existsSync(join(latestDir(repo, "latest-scan.json"), "change.diff"))).toBe(false);
  });

  it("--output writes through a symbolic link and truncates its target", () => {
    const repo = repoWithChange();
    const victim = join(temp("victim"), "package.json");
    writeFileSync(victim, "keep me");
    const out = join(temp("out"), "report.json");
    symlinkSync(victim, out);
    const r = cli(["scan", "--no-install", "--format", "json", "--output", out], repo);
    expect(r.code).toBe(0);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(lstatSync(out).isSymbolicLink()).toBe(false);
    expect((JSON.parse(readFileSync(out, "utf8")) as { kind: string }).kind).toBe("scan");
  });

  it("--only with a prototype name or an empty list selects nothing and passes", () => {
    const repo = repoWithChange();
    for (const args of [["--only", "constructor"], ["--only=,"], ["--skip", "toString"]]) {
      const r = cli(["scan", "--no-install", ...args], repo);
      expect(r.code, args.join(" ")).toBe(2);
    }
  });
});

describe("install worker", () => {
  it("the hidden install worker takes any name and a failure exits 1", () => {
    const h = temp("whome");
    for (const name of ["../../victim", "constructor", "sqllint"]) {
      const r = cli(["__install", name], tmpdir(), { OPENQODEX_HOME: h });
      expect(r.code, name).toBe(2);
    }
    expect(readdirSync(h)).toEqual([]);
  });
});

describe("doctor", () => {
  it("doctor --install installs while --offline or --no-install is given", () => {
    for (const flag of ["--offline", "--no-install"]) {
      const h = temp("dhome");
      const r = cli(["doctor", "--install", flag], tmpdir(), { OPENQODEX_HOME: h });
      expect(r.code, flag).toBe(2);
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
      expect(readdirSync(h)).toEqual([]);
    }
  });

  it("doctor --install installs what the repository's files call for; outside one, or with --all-scanners, every scanner (23)", () => {
    const repo = temp("ts");
    git(repo, ["init", "--quiet", "-b", "main"]);
    mkdirSync(join(repo, "app"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { "react-native": "0.76.0", react: "18.3.1" } }));
    writeFileSync(join(repo, "app/index.tsx"), "export default function Home() { return null; }\n");
    writeFileSync(join(repo, "Gemfile"), "gem 'cocoapods'\n");
    writeFileSync(join(repo, "deploy.sh"), "echo hi\n");
    writeFileSync(join(repo, ".openqodex.yaml"), "scanners:\n  disable: [shellcheck]\n");
    const inRepo = JSON.parse(cli(["doctor", "--json"], repo).stdout) as { downloads: string[] | null; selection: { scanner: string; wanted: boolean; line: string }[]; toolchain: string };
    expect(inRepo.downloads).toEqual(["semgrep", "gitleaks", "oxlint"]);
    expect(inRepo.selection.find((c) => c.scanner === "shellcheck")).toEqual({ scanner: "shellcheck", wanted: false, line: "shellcheck: disabled in .openqodex/config.yaml" });
    expect(inRepo.toolchain).toMatch(/^[0-9a-f]{64}$/);
    const text = cli(["doctor"], repo).stdout;
    expect(text).toContain("This repository needs\n  semgrep: any file\n  gitleaks: any file\n  oxlint: JavaScript or TypeScript files");
    expect(text).toMatch(/Not needed here: .*brakeman/);

    const outside = JSON.parse(cli(["doctor", "--json"], temp("plain")).stdout) as { downloads: string[] | null; selection: unknown };
    expect(outside).toMatchObject({ downloads: null, selection: null });
    const alone = cli(["doctor", "--all-scanners"], repo);
    expect(alone.code).toBe(2);
    expect(alone.stderr).toContain("--all-scanners goes with --install");
    const requireAlone = cli(["doctor", "--install", "--require-all"], repo);
    expect(requireAlone.code).toBe(2);
    expect(requireAlone.stderr).toContain("--require-all goes with --install --all-scanners");
  });

  it("doctor exits 0 for a --config or --cwd that does not exist", () => {
    const repo = repoWithChange();
    let r = cli(["doctor", "--config", join(repo, "missing.yaml")], repo);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("config file not found");
    r = cli(["doctor", "--cwd", join(repo, "no-such-folder")], repo);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("Scanners");
  });
});

describe("guide", () => {
  it("an unknown topic exits 0", () => {
    const bad = cli(["guide", "no-such-topic"], tmpdir());
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("Topics:");
  });

  it("guide reads assets from the current folder, so an installed package finds nothing", () => {
    const packDir = temp("pack");
    execFileSync("npm", ["pack", "--pack-destination", packDir, "--silent"], { cwd: cliRoot, encoding: "utf8" });
    const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
    expect(tgz).toBeDefined();
    const install = temp("install");
    writeFileSync(join(install, "package.json"), "{}");
    execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", join(packDir, tgz as string)], {
      cwd: install,
      encoding: "utf8",
    });
    const bin = join(install, "node_modules", "openqodex", "dist", "bin.js");
    const elsewhere = temp("elsewhere");
    const r = spawnSync(process.execPath, [bin, "guide"], { cwd: elsewhere, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("name: openqodex");
    const docs = join(install, "node_modules", "openqodex", "docs");
    if (existsSync(docs)) {
      const topic = readdirSync(docs).find((f) => f.endsWith(".md"))?.slice(0, -3);
      if (topic !== undefined) {
        const t = spawnSync(process.execPath, [bin, "guide", topic], { cwd: elsewhere, encoding: "utf8" });
        expect(t.status).toBe(0);
        expect(t.stdout).toBe(readFileSync(join(docs, `${topic}.md`), "utf8"));
      }
    }
    // npm pack and npm install take longer than the default limit on a CI runner.
  }, 120_000);
});

describe("demo", () => {
  it("demo commits the plant, needs a git identity or reuses a fixed key", () => {
    const keys: string[] = [];
    for (let i = 0; i < 2; i++) {
      const dir = join(temp("demo"), "repo");
      // No git identity anywhere: the demo must not need one.
      const r = cli(["demo", dir, "--no-install"], tmpdir(), { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
      expect(r.stderr).not.toContain("openqodex failed");
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("review my change with openqodex");
      const changed = status(dir);
      for (const f of ["app/config.py", "app/search.py", "Dockerfile", "scripts/deploy.sh"]) expect(changed).toContain(f);
      const config = readFileSync(join(dir, "app", "config.py"), "utf8");
      const key = /sk_live_[A-Za-z0-9]{24}/.exec(config)?.[0];
      expect(key).toBeDefined();
      expect(config).not.toContain("{{GENERATED_SECRET}}");
      keys.push(key as string);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("demo's commit lands in the repo an inherited GIT_DIR points to", () => {
    const other = repoWithChange();
    const head = git(other, ["rev-parse", "HEAD"]);
    const dir = join(temp("demo"), "repo");
    const r = cli(["demo", dir, "--no-install"], tmpdir(), {
      GIT_DIR: join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: join(other, ".git", "index"),
    });
    expect(r.code).toBe(0);
    expect(git(other, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(dir, ["log", "--format=%s"]).trim()).toBe("Demo baseline");
  });

  it("demo accepts a flag it ignores", () => {
    for (const args of [["--config", "/tmp/x.yaml"], ["--format", "json"], ["--cwd", "/tmp"]]) {
      const r = cli(["demo", join(temp("demo"), "repo"), ...args], tmpdir());
      expect(r.code, args.join(" ")).toBe(2);
    }
  });

  it("demo writes into a folder that is not empty", () => {
    const dir = temp("full");
    mkdirSync(join(dir, "x"));
    const r = cli(["demo", dir, "--no-install"], tmpdir());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not empty");
  });
});
