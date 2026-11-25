// The feedback offer, run as real subprocesses of the built dist/bin.js in
// real temp git repos. Build first (`pnpm build`). Every run gets a PATH that
// holds only git and a recorder standing in for `open` and `xdg-open` (a test
// harness for the browser, an external command): `gh` is never on it, so no
// run can create a real issue, and the recorder shows whether anything tried
// to leave the machine.
//
// Ways the feedback offer could fail, written before the code:
// 1. The CLI's own failure exits with something other than 2, or prints an
//    issue that differs from the documented text, or drops the two choices
//    or the line that says how to send it later.
// 2. The issue body carries a path, the repo's name, a changed file's name,
//    the user's name or a key-shaped token from an error line or from the
//    developer's own words.
// 3. A scanner that ended `failed` prints no offer, or prints it twice; a
//    scanner that is only not installed prints one.
// 4. A run without a terminal sends something (opens the browser) without
//    the developer choosing 1.
// 5. `report --send-last` sends a title or body that differs from the one
//    shown, or sends nothing.
// 6. `hook check` prints the offer, so the agent's push gate gets noise, or
//    exits other than 0.
// Added after the review round:
// 7. A scanner's stderr or an error's free text reaches the body; a scanner
//    diagnostic must be a fixed failure class only.
// 8. A token with no digit (ghp_ with letters only), a labelled secret
//    (token=...), an email or a bare file name survives in the body.
// 9. A quoted path with spaces leaves a word of it behind, or a one or two
//    letter user name survives.
// 10. A custom scanner's name, which comes from the repo's config, appears in
//     the body.
// 11. A report that could not be saved still advertises --send-last, which
//     then sends an older issue.
// 12. --send-last follows a symbolic link, or sends a saved body that was
//     edited after it was shown, or sends without printing it again.
// 13. --send-last refuses a preview an earlier version saved, whose first
//     line differs from today's.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(cliRoot, "dist", "bin.js");
const VERSION = (JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as { version: string }).version;
const OS = ({ darwin: "macOS", linux: "Linux", win32: "Windows" } as Record<string, string>)[process.platform] ?? process.platform;
const ENVIRONMENT = `Environment: ${OS}, ${process.arch}, Node ${process.versions.node.split(".")[0]}`;
const HEADLINE = "OpenQodex had a problem. This issue report has not been sent.";
const LATER = "To create the issue, run: openqodex report --send-last\nTo ignore it, do nothing\n";

function temp(prefix: string): string {
  return tempDir(`oq-feedback-${prefix}-`);
}

// A folder for PATH with git and a recorder for the browser openers.
function harness(): { path: string; record: string } {
  const bin = temp("bin");
  const record = join(temp("record"), "url.txt");
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  symlinkSync(git, join(bin, "git"));
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s' "$1" > '${record}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { path: bin, record };
}

type Result = { code: number | null; stdout: string; stderr: string };

function cli(args: string[], cwd: string, h: { path: string }, env: Record<string, string> = {}, input = ""): Result {
  const base: NodeJS.ProcessEnv = { ...process.env, OPENQODEX_HOME: temp("home"), NO_COLOR: "1", PATH: h.path, ...env };
  for (const key of ["FORCE_COLOR", "GH_TOKEN", "GITHUB_TOKEN"]) delete base[key];
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: base, input, timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });
}

// A repo named acme-payments-<random letters> with one commit and `files` written
// on top of it, uncommitted.
function repo(files: (dir: string) => void): string {
  const dir = join(temp("parent"), `acme-payments-${Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("")}`);
  mkdirSync(dir);
  git(dir, ["init", "--quiet", "-b", "main"]);
  writeFileSync(join(dir, "notes.txt"), "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "base"]);
  files(dir);
  return dir;
}

function offers(stderr: string): number {
  return stderr.split(HEADLINE).length - 1;
}

// The title and body as the offer printed them.
function shown(stderr: string): { title: string; body: string } {
  const m = /Issue title: (.*)\nIssue body:\n([\s\S]*?)\n1 create a GitHub issue\n2 ignore\n/.exec(stderr);
  if (m === null) throw new Error(`no offer in:\n${stderr}`);
  return { title: m[1] as string, body: m[2] as string };
}

describe("feedback offer", () => {
  it("an internal error prints the exact issue with the two choices, sends nothing, keeps paths out and exits 2", () => {
    const h = harness();
    const dir = repo((d) => writeFileSync(join(d, "notes.txt"), "a\nb\n"));
    const missing = join(dir, "Acme Private Project", "out.txt");
    const r = cli(["scan", "--no-install", "--only", "sqllint", "--output", missing], dir, h);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("openqodex failed: ENOENT");
    const text = [
      HEADLINE,
      `Issue title: OpenQodex ${VERSION}: internal-error`,
      "Issue body:",
      "Command: scan --no-install --only sqllint --output <path>",
      "Component: cli",
      "Diagnostic: Error: ENOENT: no such file or directory, open <path>",
      "Scanners: sqllint no_matching_files",
      ENVIRONMENT,
      "1 create a GitHub issue",
      "2 ignore",
      "",
    ].join("\n");
    expect(r.stderr).toContain(text + LATER);
    expect(offers(r.stderr)).toBe(1);
    expect(existsSync(h.record)).toBe(false);
    const kept = JSON.parse(readFileSync(join(dir, ".openqodex", "last-report.json"), "utf8")) as { body: string };
    expect(kept.body).not.toContain(dir);
    expect(kept.body).not.toContain(basename(dir));
    expect(kept.body).not.toContain("Private");
  });

  it("a scanner that failed prints the offer once without the file name, and a scanner not installed prints none", () => {
    const h = harness();
    // A .sql file over the in-process SQL scanner's 5 MB cap: it refuses to
    // read it and ends failed. (A link is never handed to a scanner at all.)
    const failing = repo((d) => writeFileSync(join(d, "ledger-migration.sql"), "-- pad\n".repeat(800_000)));
    const r = cli(["scan", "--no-install", "--only", "sqllint"], failing, h);
    expect(r.code).toBe(0);
    expect(offers(r.stderr)).toBe(1);
    const issue = shown(r.stderr);
    expect(issue.title).toBe(`OpenQodex ${VERSION}: scanner-failed`);
    expect(issue.body).toContain("Component: scanner:sqllint");
    expect(issue.body).toContain("Diagnostic: sqllint: a file was too large to read\n");
    expect(issue.body).toContain("Scanners: sqllint failed");
    expect(issue.body).not.toContain("ledger-migration");
    expect(issue.body).not.toContain(basename(failing));
    expect(r.stderr).toContain(LATER);

    const missing = repo((d) => writeFileSync(join(d, "app.py"), "x = 1\n"));
    const quiet = cli(["scan", "--no-install"], missing, h);
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toMatch(/not installed/);
    expect(offers(quiet.stderr)).toBe(0);
  });

  it("a custom scanner's name from the repo's config never reaches the issue", () => {
    const h = harness();
    const config = "scanners:\n  custom:\n    - source: https://github.com/acme/zorbpay-lint\n      run: zorbpay-lint {target}\n";
    const dir = repo((d) => {
      writeFileSync(join(d, ".openqodex.yaml"), config);
      writeFileSync(join(d, "ledger.sql"), "-- pad\n".repeat(800_000));
    });
    const r = cli(["scan", "--no-install", "--only", "sqllint,custom:zorbpay-lint"], dir, h);
    const issue = shown(r.stderr);
    expect(issue.body).toContain("custom scanner untrusted");
    expect(issue.body).not.toContain("zorbpay");
  });

  it("report refuses words that hold a path, a file name, a key-shaped token or an email, and saves nothing", () => {
    const h = harness();
    const dir = repo(() => {});
    const hostile = [
      "it broke in /srv/app/x",
      "it broke on payroll.csv",
      // Built at run time so no token-shaped literal sits in the repo.
      `my token ${["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"].join("_")} leaked`,
      "api_key=abcdefghijklmnopqrstuvwxyz was printed",
      "mail alice@example.com about it",
    ];
    for (const words of hostile) {
      const r = cli(["report", words], dir, h);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("remove");
      expect(offers(r.stderr)).toBe(0);
      expect(existsSync(join(dir, ".openqodex", "last-report.json"))).toBe(false);
    }
  });

  it("report replaces the user name, even a two letter one, and the repo name in the developer's words", () => {
    const h = harness();
    const dir = repo(() => {});
    const name = basename(dir);
    const r = cli(["report", `zq ran the review in ${name} and it hung`], dir, h, { USER: "zq" });
    expect(r.code).toBe(0);
    const issue = shown(r.stderr);
    expect(issue.title).toBe(`OpenQodex ${VERSION}: developer-report`);
    expect(issue.body).toContain("Command: report\nComponent: report\nDiagnostic: <name> ran the review in <name> and it hung\n");
    expect(existsSync(h.record)).toBe(false);
  });

  it("a report that could not be saved does not offer --send-last", () => {
    const h = harness();
    const dir = repo(() => {});
    const elsewhere = join(temp("elsewhere"), "target.json");
    writeFileSync(elsewhere, "untouched\n");
    mkdirSync(join(dir, ".openqodex"));
    symlinkSync(elsewhere, join(dir, ".openqodex", "last-report.json"));
    const r = cli(["report", "the review hung"], dir, h);
    expect(offers(r.stderr)).toBe(1);
    expect(r.stderr).toContain("the report could not be saved; nothing to send");
    expect(r.stderr).not.toContain("--send-last");
    expect(readFileSync(elsewhere, "utf8")).toBe("untouched\n");
  });

  it("report --send-last refuses a linked or edited saved report and sends nothing", () => {
    const h = harness();
    const dir = repo(() => {});
    cli(["report", "the review hung"], dir, h);
    const saved = join(dir, ".openqodex", "last-report.json");
    const original = readFileSync(saved, "utf8");

    const edited = JSON.parse(original) as { body: string };
    edited.body = edited.body.replace("the review hung", "SELECT * FROM customers");
    writeFileSync(saved, JSON.stringify(edited));
    const tampered = cli(["report", "--send-last"], dir, h);
    expect(tampered.code).toBe(2);
    expect(existsSync(h.record)).toBe(false);

    const real = join(temp("linked"), "last-report.json");
    writeFileSync(real, original);
    rmSync(saved);
    symlinkSync(real, saved);
    const linked = cli(["report", "--send-last"], dir, h);
    expect(linked.code).toBe(2);
    expect(existsSync(h.record)).toBe(false);
  });

  it("report --send-last sends a preview an earlier version saved with its old first line", () => {
    const h = harness();
    const dir = repo(() => {});
    cli(["report", "the review hung"], dir, h);
    const saved = join(dir, ".openqodex", "last-report.json");
    const v = JSON.parse(readFileSync(saved, "utf8")) as { title: string; body: string; sha256: string };
    const old = ["OpenQodex had a problem. Nothing has been sent.", `Issue title: ${v.title}`, "Issue body:", v.body, "1 create a GitHub issue", "2 ignore", ""].join("\n");
    v.sha256 = createHash("sha256").update(old).digest("hex");
    writeFileSync(saved, JSON.stringify(v));
    const r = cli(["report", "--send-last"], dir, h);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(h.record)).toBe(true);
  });

  it("hook check prints no offer and exits 0 when its input breaks", () => {
    const h = harness();
    const dir = repo(() => {});
    const r = cli(["hook", "check"], dir, h, {}, "{not json");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(offers(r.stderr)).toBe(0);
    expect(r.stderr).not.toContain("send-last");
  });
});
