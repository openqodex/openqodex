// `openqodex hook check` and `hook install|uninstall`, run as the real
// built CLI on temp repos.
//
// Ways it could fail, written before the code:
//  1. A command that is not a push (echo "git push", a here-document body,
//     git pushx, a commit message holding the word push) is treated as one.
//  2. A real push is missed: inside a compound command, a subshell, a
//     command substitution, an if block, behind VAR=value, after git's
//     global options, through a git alias, with a redirect attached.
//  3. The wrong repo is checked (-C, --git-dir, --work-tree, GIT_DIR, cd,
//     a cd inside parentheses leaking out), or only the first of two pushes.
//  4. Garbage on stdin, stdin left open, or a broken launcher exits non-zero,
//     hangs, or prints something.
//  5. It prints permissionDecision "allow" or "ask".
//  6. Warn mode denies; block mode with no review does not deny; a passing
//     review of the same change still warns.
//  7. OPENQODEX_SKIP=1 is ignored.
//  8. The git hook can block a push because the tool failed to start, lacks
//     the marker, overwrites a foreign hook or an earlier backup, ignores
//     core.hooksPath, or uninstall removes a hook that is not ours or that
//     the developer edited.
//  9. A scan after a finalized review of the same change makes the push
//     gate forget the review (the scan overwrote the review receipt).
// 10. The pre-push hook prints raw scanner findings or starts a full review.
// 11. The pre-push hook looks up the checked-out work instead of the pushed
//     commit, so a push of another branch counts as reviewed.
// 12. The agent hook blocks on an incomplete record.
// 13. The agent hook stays silent for an unreviewed change.
// 14. A legacy receipt (the old two-step protocol) counts as a complete
//     review, or blocks a push that it passed.
// 15. A record the repository carries (a force-added .openqodex/latest.json
//     and report for its own change) counts as a review: only the record in
//     the developer's own OpenQodex home may.
// 16. A legacy finalize writes no record in the home, so older installs are
//     suddenly blocked.
// 17. A branch reviewed with no upstream (measured from the merge base with
//     the default branch) and pushed over its remote tip counts as unreviewed
//     forever; or a review of another head covers the push.
// 18. A later review of other work, saved as the newest record, hides an
//     earlier complete review that contains the push.
// 19. The line printed for husky drops git's hook arguments, so a push to a
//     remote other than origin is looked up against origin.
// 20. The line printed for lefthook puts git's hook arguments into a shell
//     line: lefthook inserts {1} and {2} raw, so a remote URL holding
//     '$(id)' closes the quotes and runs.
// 21. A push whose net change touches only .openqodex/, which a review
//     leaves out and so never records, is denied in a blocking repo by
//     either hook (issue 279); or a push that also changes another file, or
//     whose base git cannot read, goes through without a review.
// 22. A change that looks like it touches only .openqodex/ passes while the
//     push sends unreviewed code: measured from a base only a local branch
//     holds, through a replace ref, or from a working tree that undoes a
//     commit the push sends.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  DEFAULT_CONFIG,
  getChange,
  loadConfig,
  openReportDir,
  scanReport,
  writeLatest,
  writeReportFiles,
  type Report,
} from "@openqodex/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BIN, cli, env, git, sandbox, type Sandbox } from "./init-helpers.js";
import { gateReceipt } from "@openqodex/core";
import { readHomeReceipt, writeHomeReceipt } from "../src/receipts.js";
import { pushFolders } from "../src/agents/push-command.js";
import { aliasOf, plainPush } from "../src/commands/hook.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

function check(s: Sandbox, command: string, opts: { env?: Record<string, string>; cwd?: string } = {}) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: opts.cwd ?? s.repo });
  const r = cli(s, ["hook", "check"], { input, env: opts.env });
  expect(r.status).toBe(0);
  expect(r.stdout).not.toMatch(/"permissionDecision":"(allow|ask)"/);
  return r;
}

const UNREVIEWED = "OpenQodex has not reviewed this change";
const COULD_NOT = "could not tell what this push sends";
const BLOCK = ".openqodex.yaml";
const BLOCK_YAML = "review:\n  block_on_severity: major\n";

describe("hook check: which commands are pushes", () => {
  let s: Sandbox;
  beforeAll(() => {
    s = sandbox({ "README.md": "hello\n", "sub/file.txt": "x\n" });
    git(s.repo, "config", "alias.ship", "push origin HEAD");
    writeFileSync(join(s.repo, "README.md"), "changed\n");
  });

  // Every line but a plain `git push`, which the hook checks as the current
  // work; these the hook cannot tell, so it says so.
  const pushes = [
    "git -C sub push",
    "git -Csub push",
    "FOO=1 git push",
    "npm test && git push origin main",
    "cd sub && git push",
    "git --no-pager -c push.default=current push",
    "git -c alias.publish=push publish",
    "git ship",
    "echo `git push`",
    'echo "$(git push)"',
    "git push>/tmp/openqodex-test-log",
    "if true; then git push; fi",
    "for r in a; do git push; done",
    "{ git push; }",
    "! git push",
    "cat <<EOF\nhello\nEOF\ngit push",
  ];
  const notPushes = [
    "git status",
    "echo git push",
    'git commit -m "push"',
    "git pushx",
    'echo "git push"',
    "echo 'git push && x'",
    "cat <<'EOF'\ngit push\nEOF",
    "git -c alias.publish=status publish",
  ];

  // The parser alone, in process (`pushFolders` finds the pushes, with git's
  // real alias lookup; `plainPush` tells a plain one). The three CLI runs
  // after the tables prove `hook check` answers by them.
  it.each(pushes)("treats %j as a push it cannot tell", async (command) => {
    expect(await pushFolders(command, s.repo, aliasOf)).not.toEqual([]);
    expect(plainPush(command)).toBeNull();
  });

  it.each(notPushes)("treats %j as not a push", async (command) => {
    expect(await pushFolders(command, s.repo, aliasOf)).toEqual([]);
  });

  it("asks for a review of the current work on a plain git push", () => {
    expect(check(s, "git push").stdout).toContain(UNREVIEWED);
  });

  it("says it cannot tell what a push inside a compound line sends", () => {
    expect(check(s, "cd sub && git push").stdout).toContain(COULD_NOT);
  });

  it("prints nothing for a line that only names git push", () => {
    expect(check(s, "echo git push").stdout).toBe("");
  });

  it("garbage on stdin prints nothing and exits 0", () => {
    const r = cli(s, ["hook", "check"], { input: "not json at all" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("stdin left open ends within the deadline, exit 0, nothing printed", async () => {
    const child = spawn(process.execPath, [BIN, "hook", "check"], { cwd: s.repo, env: env(s) });
    child.stdin.write(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: s.repo }));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.stdin.destroy();
    expect(code).toBe(0);
    expect(stdout).toBe("");
    // A crash also exits 0 with nothing on stdout; it names itself on stderr.
    expect(stderr).toBe("");
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("OPENQODEX_SKIP=1 abstains and says so", () => {
    const r = check(s, "git push", { env: { OPENQODEX_SKIP: "1" } });
    expect(r.stdout).toContain("OpenQodex check skipped (OPENQODEX_SKIP is set)");
    expect(r.stdout).not.toContain("permissionDecision");
  });
});

// Writes the files a complete passing review of the current change leaves in
// the repository, through the core functions: what a branch could carry.
// `status` "incomplete" writes the record of a review that did not finish.
async function repoRecord(repo: string, status: "complete" | "incomplete" = "complete"): Promise<{ report: Report; dir: string }> {
  const change = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
  const report: Report = {
    ...scanReport({
      change,
      scan: { candidates: [], scanners: [], fixturesDropped: 0, secretFingerprints: [] },
      config: DEFAULT_CONFIG,
    }),
    kind: "review",
    // Judged under the repo's own threshold, as finalize does.
    block_on_severity: loadConfig(repo).config.blockOnSeverity,
    ...(status === "incomplete" ? { verdict: "incomplete" as const } : {}),
    completion: { status, missing: status === "complete" ? [] : ["the reviewer timed out and was stopped"] } as unknown as Report["completion"],
  };
  const dir = openReportDir(repo, change.shortId);
  writeReportFiles(repo, dir, { "report.json": JSON.stringify(report) });
  const done = status === "complete";
  writeLatest(repo, { dir: relative(repo, dir), change_id: change.id, kind: "review", finalized: done, verdict: done ? "passed" : null, completion: status });
  return { report, dir: relative(repo, dir) };
}

// The same review with its record in the developer's OpenQodex home, as
// `review` writes it at the end of a run.
async function finalizedPassingReview(oqHome: string, repo: string, status: "complete" | "incomplete" = "complete"): Promise<void> {
  const { report, dir } = await repoRecord(repo, status);
  writeHomeReceipt(oqHome, repo, gateReceipt(report, status, dir));
}

function blockingRepo(root: string, name: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, BLOCK), BLOCK_YAML);
  git(repo, "add", "-A");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "start");
  writeFileSync(join(repo, "a.txt"), "change\n");
  return repo;
}

// A bare remote holding the start commit as the branch's upstream, then the
// change in the work tree committed: `git push` sends exactly that change,
// the change a review of the committed work records.
function published(s: Sandbox, repo = s.repo): void {
  const remote = tempDir("oq-hook-remote-");
  git(repo, "init", "-q", "--bare", remote);
  git(repo, "remote", "add", "origin", remote);
  const branch = git(repo, "symbolic-ref", "--short", "HEAD").trim();
  git(repo, "push", "-q", "-u", "origin", branch);
  commitAll(repo);
}

function commitAll(repo: string): void {
  git(repo, "add", "-A");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "change");
}

function decision(stdout: string): string | undefined {
  return stdout === "" ? undefined : (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision?: string } }).hookSpecificOutput.permissionDecision;
}

describe("hook check: decisions", () => {
  it("12. a finalized passing review of the same change prints nothing, stops covering it once the change moves, and an incomplete record of the moved change never blocks, even in block mode", async () => {
    const s = sandbox({ "README.md": "hello\n", [BLOCK]: BLOCK_YAML });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    published(s);
    await finalizedPassingReview(s.oqHome, s.repo);
    expect(check(s, "git push").stdout).toBe("");
    writeFileSync(join(s.repo, "README.md"), "changed again\n");
    commitAll(s.repo);
    expect(decision(check(s, "git push").stdout)).toBe("deny");
    await finalizedPassingReview(s.oqHome, s.repo, "incomplete");
    const r = check(s, "git push");
    expect(decision(r.stdout)).toBeUndefined();
    expect(r.stdout).toContain("incomplete");
  });

  it("checks a plain push in the folder it runs in, and treats any other form as unresolved", async () => {
    const s = sandbox();
    const a = blockingRepo(s.root, "a");
    published(s, a);
    await finalizedPassingReview(s.oqHome, a);
    const at = (cwd: string, command: string) => check(s, command, { cwd }).stdout;
    expect(at(a, "git push")).toBe("");
    for (const command of ["git -C a push", "cd a && git push", "(cd a && git push)", "GIT_DIR=a/.git git push"]) {
      const out = at(s.root, command);
      expect(decision(out), command).toBe("deny");
      expect(out, command).toContain(COULD_NOT);
    }
  });
});

describe("hook check through the launcher", () => {
  it("exits 0 with one repair line when no node can be found or the CLI cannot start", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    const launcher = join(s.oqHome, "bin/openqodex");
    const text = readFileSync(launcher, "utf8");
    const emptyPath = tempDir("oq empty path ");
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: s.repo });

    writeFileSync(launcher, text.replace(/^node=.*$/m, "node='/nonexistent/node'"));
    const noNode = spawnSync("/bin/sh", [launcher, "hook", "check"], { input, encoding: "utf8", env: { ...env(s), PATH: emptyPath } });
    expect(noNode.status).toBe(0);
    expect(noNode.stdout).toBe("");
    expect(noNode.stderr).toContain("openqodex");

    // Every runtime path, so the runtime/current pointer cannot find one either.
    writeFileSync(launcher, text.replace(/dist\/bin\.js/g, "dist/missing.js"));
    const broken = spawnSync("/bin/sh", [launcher, "hook", "check"], { input, encoding: "utf8", env: env(s) });
    expect(broken.status).toBe(0);
    expect(broken.stderr).toContain("openqodex");
  });
});

describe("hook install and uninstall", () => {
  it("installs the runtime and launcher when missing, and the hook calls the launcher, not npx", () => {
    const s = sandbox();
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    const hook = join(s.repo, ".git/hooks/pre-push");
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    const text = readFileSync(hook, "utf8");
    expect(text).not.toContain("npx");
    expect(text).toContain(join(s.oqHome, "bin/openqodex"));
    expect(existsSync(join(s.oqHome, "bin/openqodex"))).toBe(true);
    expect(cli(s, ["hook", "uninstall"]).status).toBe(0);
    expect(existsSync(hook)).toBe(false);
  });

  it("a scan that fails to run never blocks the push", () => {
    // A blocking repository and an unreviewed commit: the hook blocks this
    // push while it can start, so the pass below is the failed start's.
    const s = sandbox({ "README.md": "hello\n", [BLOCK]: BLOCK_YAML });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    published(s);
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    const branch = git(s.repo, "symbolic-ref", "--short", "HEAD").trim();
    const line = `refs/heads/${branch} ${git(s.repo, "rev-parse", "HEAD").trim()} refs/heads/${branch} ${git(s.repo, "rev-parse", "@{upstream}").trim()}\n`;
    const remote = git(s.repo, "remote", "get-url", "origin").trim();
    const prePush = () => spawnSync(join(s.repo, ".git/hooks/pre-push"), ["origin", remote], { cwd: s.repo, env: env(s), input: line, encoding: "utf8" });
    const blocked = prePush();
    expect(blocked.status, blocked.stderr).toBe(1);
    expect(blocked.stderr).toContain(UNREVIEWED);
    // The runtime copy is gone: the scan cannot start at all.
    rmSync(join(s.oqHome, "runtime"), { recursive: true });
    expect(prePush().status).toBe(0);
  });

  it("refuses a foreign hook without --force; --force twice keeps both earlier hooks", () => {
    const s = sandbox();
    const hook = join(s.repo, ".git/hooks/pre-push");
    writeFileSync(hook, "#!/bin/sh\necho first\n");
    expect(cli(s, ["hook", "install"]).status).toBe(2);
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho first\n");

    expect(cli(s, ["hook", "install", "--force"]).status).toBe(0);
    expect(cli(s, ["hook", "uninstall"]).status).toBe(0);
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho first\n");
    writeFileSync(hook, "#!/bin/sh\necho second\n");
    expect(cli(s, ["hook", "install", "--force"]).status).toBe(0);
    writeFileSync(hook, "#!/bin/sh\necho third\n");
    expect(cli(s, ["hook", "install", "--force"]).status).toBe(0);
    const kept = readdirSync(join(s.repo, ".git/hooks"))
      .filter((n) => n.startsWith("pre-push.openqodex.bak"))
      .map((n) => readFileSync(join(s.repo, ".git/hooks", n), "utf8"));
    expect(kept.sort()).toEqual(["#!/bin/sh\necho second\n", "#!/bin/sh\necho third\n"]);
  });

  it("uninstall leaves a hook the developer edited after install", () => {
    const s = sandbox();
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    const hook = join(s.repo, ".git/hooks/pre-push");
    const edited = `${readFileSync(hook, "utf8")}echo my own check\n`;
    writeFileSync(hook, edited);
    expect(cli(s, ["hook", "uninstall"]).status).toBe(0);
    expect(readFileSync(hook, "utf8")).toBe(edited);
  });

  it("honours core.hooksPath", () => {
    const s = sandbox();
    mkdirSync(join(s.repo, "my-hooks"));
    git(s.repo, "config", "core.hooksPath", "my-hooks");
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    expect(existsSync(join(s.repo, "my-hooks/pre-push"))).toBe(true);
  });
});

// A real review through the CLI: the brief, an empty submission, finalize.
function reviewAndFinalize(s: Sandbox): void {
  expect(cli(s, ["review", "--agent", "--no-install"]).status).toBe(0);
  const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string; change_id: string };
  const findings = { version: 1, change_id: latest.change_id, summary: "Checked.", reviewer: "subagent", findings: [] };
  writeFileSync(join(s.repo, latest.dir, "agent-findings.json"), JSON.stringify(findings));
  const r = cli(s, ["review", "--finalize"]);
  expect(r.status, r.stderr).toBe(0);
}

const LEGACY = "reviewed by the coding agent you are using";

describe("the record the hooks trust", () => {
  it("15. a complete passing record the repository carries counts as no review", async () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    published(s);
    await repoRecord(s.repo);
    const warn = check(s, "git push").stdout;
    expect(warn).toContain(UNREVIEWED);
    expect(decision(warn)).toBeUndefined();
    writeFileSync(join(s.repo, BLOCK), BLOCK_YAML);
    await repoRecord(s.repo);
    expect(decision(check(s, "git push").stdout)).toBe("deny");
  });
});

describe("the review receipt", () => {
  it("9, 14. a legacy review lets a blocking repo push with one line, through the agent hook and the pre-push hook, and a later scan does not make either forget the review", () => {
    const s = sandbox({ "README.md": "hello\n", [BLOCK]: BLOCK_YAML });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    published(s);
    reviewAndFinalize(s);
    const first = check(s, "git push").stdout;
    expect(decision(first)).toBeUndefined();
    expect(first).toContain(LEGACY);
    expect(cli(s, ["scan", "--no-install"]).status).toBe(0);
    expect(check(s, "git push").stdout).toBe(first);
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    const r = push(s);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(LEGACY);
  }, 60_000);
});

function withRemote(s: Sandbox): void {
  git(s.root, "init", "-q", "--bare", join(s.root, "remote.git"));
  git(s.repo, "remote", "add", "origin", join(s.root, "remote.git"));
  git(s.repo, "push", "-q", "origin", "main");
}

function push(s: Sandbox, ...args: string[]) {
  const r = spawnSync("git", ["push", ...args], { cwd: s.repo, env: env(s), encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("the pre-push hook looks up the review of what the push sends", () => {
  it("10. with no review it prints one line, no scanner output, starts no review and lets the push through", () => {
    const s = sandbox({ "README.md": "hello\n" });
    withRemote(s);
    writeFileSync(join(s.repo, "deploy.sh"), "#!/bin/sh\necho $1\n");
    git(s.repo, "add", "-A");
    git(s.repo, "commit", "-q", "-m", "a script");
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    const r = push(s, "origin", "main");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(UNREVIEWED);
    expect(r.out).not.toMatch(/shellcheck|semgrep|gitleaks|raw finding|candidates to check|Reviewer/);
    expect(existsSync(join(s.repo, ".openqodex/latest-scan.json"))).toBe(false);
    expect(existsSync(join(s.repo, ".openqodex/reviews"))).toBe(false);
  }, 60_000);

  // A branch the remote already has, reviewed with no upstream set: the
  // review measured from the merge base with the default branch, the push
  // from the remote branch's tip.
  async function reviewedFeature(s: Sandbox): Promise<void> {
    withRemote(s);
    git(s.repo, "remote", "set-head", "origin", "main");
    git(s.repo, "checkout", "-q", "-b", "feature");
    writeFileSync(join(s.repo, "one.txt"), "one\n");
    commitAll(s.repo);
    git(s.repo, "push", "-q", "origin", "feature");
    writeFileSync(join(s.repo, "two.txt"), "two\n");
    commitAll(s.repo);
    await finalizedPassingReview(s.oqHome, s.repo);
    expect(cli(s, ["hook", "install"]).status).toBe(0);
  }

  it("17, 18. a review of a branch with no upstream covers a push of that branch over its remote tip, and a later incomplete review of other work does not hide it", async () => {
    const s = sandbox({ "README.md": "hello\n", [BLOCK]: BLOCK_YAML });
    await reviewedFeature(s);
    writeFileSync(join(s.repo, "other.txt"), "other work\n");
    await finalizedPassingReview(s.oqHome, s.repo, "incomplete");
    expect(readHomeReceipt(s.oqHome, s.repo, "latest")?.kind).toBe("incomplete");
    const r = push(s, "origin", "feature");
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain(UNREVIEWED);
  }, 60_000);

  it("17. that review does not cover a push of a different head", async () => {
    const s = sandbox({ "README.md": "hello\n", [BLOCK]: BLOCK_YAML });
    await reviewedFeature(s);
    writeFileSync(join(s.repo, "three.txt"), "three\n");
    commitAll(s.repo);
    const r = push(s, "origin", "feature");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(UNREVIEWED);
    // The hint names the pushed branch, quoted, not the branch checked out.
    expect(r.out).toContain("git branch --set-upstream-to 'origin/feature' 'feature'");
  }, 60_000);

  it("11. a branch that is not checked out is looked up by its own commit, not the reviewed work in place", () => {
    const s = sandbox({ "README.md": "hello\n", [BLOCK]: BLOCK_YAML });
    withRemote(s);
    git(s.repo, "checkout", "-q", "-b", "feature");
    writeFileSync(join(s.repo, "deploy.sh"), "#!/bin/sh\necho hi\n");
    git(s.repo, "add", "-A");
    git(s.repo, "commit", "-q", "-m", "a script");
    git(s.repo, "checkout", "-q", "main");
    writeFileSync(join(s.repo, "notes.txt"), "one\n");
    reviewAndFinalize(s);
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    const r = push(s, "origin", "feature");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(UNREVIEWED);
  }, 60_000);
});

// 21. A review leaves .openqodex/ out of every change, so a push that
// changes nothing else has nothing a review could record.
describe("a push that changes only .openqodex/", () => {
  const CONFIG = ".openqodex/config.yaml";
  const blockingConfig = () => sandbox({ "a.txt": "x\n", [CONFIG]: BLOCK_YAML });
  const editConfig = (s: Sandbox, line: string) => writeFileSync(join(s.repo, CONFIG), `${BLOCK_YAML}  ${line}\n`);

  it("21. the pre-push hook lets it through with no review, and still denies one that also changes another file", () => {
    const s = blockingConfig();
    withRemote(s);
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    editConfig(s, "severity_threshold: major");
    commitAll(s.repo);
    const state = push(s, "origin", "main");
    expect(state.status, state.out).toBe(0);
    expect(state.out).not.toContain(UNREVIEWED);
    editConfig(s, "severity_threshold: minor");
    writeFileSync(join(s.repo, "a.txt"), "y\n");
    commitAll(s.repo);
    const both = push(s, "origin", "main");
    expect(both.status).not.toBe(0);
    expect(both.out).toContain(UNREVIEWED);
  }, 60_000);

  it("21. the pre-push hook measures a new branch from the base it already uses, and denies one that also changes another file", () => {
    const s = blockingConfig();
    withRemote(s);
    git(s.repo, "remote", "set-head", "origin", "main");
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    git(s.repo, "checkout", "-q", "-b", "state");
    editConfig(s, "severity_threshold: major");
    commitAll(s.repo);
    const state = push(s, "origin", "state");
    expect(state.status, state.out).toBe(0);
    expect(state.out).not.toContain(UNREVIEWED);
    git(s.repo, "checkout", "-q", "-b", "code", "main");
    editConfig(s, "severity_threshold: major");
    writeFileSync(join(s.repo, "b.txt"), "code\n");
    commitAll(s.repo);
    const both = push(s, "origin", "code");
    expect(both.status).not.toBe(0);
    expect(both.out).toContain(UNREVIEWED);
  }, 60_000);

  it("21. the pre-push hook does not let it through when git cannot read the remote's commit", () => {
    const s = blockingConfig();
    editConfig(s, "severity_threshold: major");
    commitAll(s.repo);
    const head = git(s.repo, "rev-parse", "HEAD").trim();
    const r = cli(s, ["hook", "pre-push", "origin"], { input: `refs/heads/main ${head} refs/heads/main ${"f".repeat(40)}\n` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(COULD_NOT);
  });

  it("21. the agent hook lets it through with no review, and still denies one that also changes another file", () => {
    const s = blockingConfig();
    editConfig(s, "severity_threshold: major");
    published(s);
    expect(check(s, "git push").stdout).toBe("");
    editConfig(s, "severity_threshold: minor");
    writeFileSync(join(s.repo, "a.txt"), "y\n");
    commitAll(s.repo);
    const both = check(s, "git push").stdout;
    expect(decision(both)).toBe("deny");
    expect(both).toContain(UNREVIEWED);
  });

  // A local trunk holding a code commit the remote does not have.
  function localTrunk(s: Sandbox): void {
    withRemote(s);
    git(s.repo, "checkout", "-q", "-b", "trunk");
    writeFileSync(join(s.repo, "b.txt"), "code\n");
    commitAll(s.repo);
  }

  it("22. the pre-push hook denies a new branch measured from a default base only a local branch holds", () => {
    const s = blockingConfig();
    editConfig(s, "default_base: trunk");
    commitAll(s.repo);
    localTrunk(s);
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    git(s.repo, "checkout", "-q", "-b", "newbr");
    const r = push(s, "origin", "newbr");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(UNREVIEWED);
  }, 60_000);

  it("22. the pre-push hook denies a code commit a replace ref shows with the base's tree", () => {
    const s = blockingConfig();
    withRemote(s);
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    const base = git(s.repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(s.repo, "a.txt"), "code\n");
    commitAll(s.repo);
    const code = git(s.repo, "rev-parse", "HEAD").trim();
    const fake = git(s.repo, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "fake").trim();
    git(s.repo, "replace", code, fake);
    const r = push(s, "origin", "main");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(UNREVIEWED);
  }, 60_000);

  it("22. the agent hook denies a code commit the working tree undoes", () => {
    const s = blockingConfig();
    writeFileSync(join(s.repo, "a.txt"), "code\n");
    published(s);
    writeFileSync(join(s.repo, "a.txt"), "x\n");
    const r = check(s, "git push").stdout;
    expect(decision(r)).toBe("deny");
    expect(r).toContain(UNREVIEWED);
  });

  it("22. the agent hook denies a branch whose upstream is a local branch holding code", () => {
    const s = blockingConfig();
    localTrunk(s);
    git(s.repo, "checkout", "-q", "--track", "-b", "feat", "trunk");
    editConfig(s, "severity_threshold: major");
    commitAll(s.repo);
    const r = check(s, "git push -u origin feat").stdout;
    expect(decision(r)).toBe("deny");
    expect(r).toContain(UNREVIEWED);
  });
});

// 19. The line printed for a hook manager drops git's arguments, so a push
// to a remote other than origin is looked up against origin.
describe("the line printed for a hook manager", () => {
  // A repo whose only remote is "upstream", with a branch the remote has and
  // a new commit on it that no review covers.
  function upstreamFeature(managerFile: string): Sandbox {
    const s = sandbox({ "README.md": "hello\n", [managerFile]: "pre-push:\n  commands: {}\n" });
    git(s.root, "init", "-q", "--bare", join(s.root, "remote.git"));
    git(s.repo, "remote", "add", "upstream", join(s.root, "remote.git"));
    git(s.repo, "push", "-q", "upstream", "main");
    git(s.repo, "checkout", "-q", "-b", "feature");
    writeFileSync(join(s.repo, "one.txt"), "one\n");
    commitAll(s.repo);
    git(s.repo, "push", "-q", "upstream", "feature");
    writeFileSync(join(s.repo, "two.txt"), "two\n");
    commitAll(s.repo);
    return s;
  }

  // The printed line, with the built CLI in place of the published one,
  // written as the repo's pre-push hook the way husky runs it (sh -e).
  // Install itself writes no hook beside a hook manager.
  function installLine(s: Sandbox, toHook: (line: string) => string): void {
    const r = cli(s, ["hook", "install"]);
    expect(r.status).toBe(0);
    expect(existsSync(join(s.repo, ".git/hooks/pre-push"))).toBe(false);
    const line = r.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("npx -y openqodex@"));
    expect(line).toBeDefined();
    const local = line!.replace(/^npx -y openqodex@\S+/, `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)}`);
    writeFileSync(join(s.repo, ".git/hooks/pre-push"), `#!/bin/sh\nset -e\n${toHook(local)}\n`, { mode: 0o755 });
  }

  it("19. the husky line passes the remote, so the hint names upstream", () => {
    const s = upstreamFeature(".husky/pre-commit");
    installLine(s, (line) => line);
    const r = push(s, "upstream", "feature");
    expect(r.out).toContain("git branch --set-upstream-to 'upstream/feature' 'feature'");
  }, 60_000);

  it("20. the lefthook line carries no git argument, so no remote name or URL reaches a shell line", () => {
    const s = sandbox({ "README.md": "hello\n", "lefthook.yml": "pre-push:\n  commands: {}\n" });
    const r = cli(s, ["hook", "install"]);
    expect(r.status).toBe(0);
    const line = r.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("npx -y openqodex@"));
    expect(line).toMatch(/hook pre-push \|\| \[ \$\? -ne 1 \]$/);
    expect(line).not.toContain("{");
    expect(line).not.toContain("$@");
  }, 60_000);
});
