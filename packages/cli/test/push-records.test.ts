// The record the push hooks trust lives in the developer's own OpenQodex
// home (<home>/receipts/<repo id>/<change id>.json), written by `review` at
// the end of a run. The reviewer model is the one stand-in: a driver object.
//
// Ways it could fail, written before the code:
//  1. A complete review run writes no record in the home, so the hook keeps
//     asking for a review that was done.
//  2. The record is readable by other users.
//  3. A target review (someone else's branch) writes a record that a push of
//     the developer's own change could match.
//  4. Records never go away: init does not prune those older than 30 days,
//     or prunes fresh ones.
//  5. The legacy `review --finalize` trusts a run's manifest, scan and
//     findings files in the repository folder, which a branch can carry, and
//     writes a home record for a run whose scan never ran on this machine, or
//     whose scan.json was edited after `review --agent` wrote it.
//  6. The git pre-push hook measures the pushed commit from the newest
//     review's base and ignores the remote commit git names, so a force push
//     over a remote commit that held more than the reviewed base passes.
//  8. Finalize checks the run files against the home record, then reads them
//     again to use them, so a file swapped between the check and the use is
//     trusted.
//  9. The agent hook counts as reviewed a push line it does not recognise
//     exactly (anything but `git push` with a few options, a remote and the
//     current branch), or lets git's push settings change its answer.
// 11. An unreadable config blocks instead of taking the tool-error path
//     (allow, one line).
// 10. The git hook passes a push where one range among several is unreviewed.
// 14. The git hook blocks a push that sends nothing (empty stdin) on the
//     state of the work tree.
// 15. A config the push breaks in the work tree lets the git hook pass the
//     push in a blocking repo; or a repo that never validly chose blocking
//     is locked out by a broken file.
//  7. The agent hook lets `git push origin unreviewed:main` pass on the
//     review of the current work.
import { stagedFake } from "../../review/test/staged-fake.js";
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChange } from "@openqodex/core";
import { parseFlags } from "../src/flags.js";
import { runReview } from "../src/review-run.js";
import { homeReceiptPath, homeRunPath, readHomeReceipt, readHomeRun } from "../src/receipts.js";
import { runMatches } from "../src/commands/review.js";
import { DEPTH_ENV } from "@openqodex/review";
import type { ReviewerDriver, ReviewerSession, Turn } from "@openqodex/review";
import { cli, sandbox, type Sandbox } from "./init-helpers.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

// An empty, valid submission after reading the changed file.
const driver: ReviewerDriver = {
  name: "claude",
  traced: true,
  detect: async () => ({ ok: true, version: "9.9.9", bin: "/fake/claude" }),
  start({ snapshotDir }): ReviewerSession {
    return stagedFake({
      pid: 1,
      async send(text: string): Promise<Turn> {
        const id = /`change_id`: `([0-9a-f]{12})`/.exec(text)?.[1] ?? "missing";
        const finalText = JSON.stringify({ version: 2, change_id: id, summary: "Edits the readme.", findings: [], dropped: [] });
        return { finalText, calls: [{ tool: "Read", input: { file_path: "README.md" }, ok: true, read: { path: "README.md", start: 1, lines: 1 } }], usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: null }, sessionId: "f", failure: null };
      },
      async close() {},
    }, snapshotDir);
  },
};

let s: Sandbox;
beforeEach(() => {
  s = sandbox({ "README.md": "hello\n" });
  vi.stubEnv("OPENQODEX_HOME", s.oqHome);
  vi.stubEnv(DEPTH_ENV, "");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function review(target?: string): Promise<number> {
  const { global } = parseFlags(["--cwd", s.repo, "--no-color", "--format", "json", "--no-install", ...(target ? ["--offline"] : [])], {});
  return runReview({ flags: global, scope: {}, target, base: target ? "main" : undefined, noGraph: true, timeoutMs: 60_000, drivers: [driver] });
}

function check(command = "git push"): string {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: s.repo });
  const r = cli(s, ["hook", "check"], { input });
  expect(r.status).toBe(0);
  return r.stdout;
}

const sh = (...a: string[]) => {
  const r = spawnSync("git", a, { cwd: s.repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
// The start commit on a bare remote as the branch's upstream.
function published(): void {
  const remote = tempDir("oq-remote-");
  spawnSync("git", ["init", "-q", "--bare", remote]);
  sh("remote", "add", "origin", remote);
  sh("push", "-q", "-u", "origin", sh("symbolic-ref", "--short", "HEAD"));
}
function commitAll(): void {
  sh("add", "-A");
  sh("commit", "-q", "-m", "change");
}

describe("the home record", () => {
  it("1, 2. a complete review writes a 0600 record in the home, and the agent hook is silent for that change", async () => {
    published();
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    commitAll();
    expect(await review()).toBe(0);
    const change = await getChange({ repoRoot: s.repo, scope: {}, exclude: [] });
    expect(readHomeReceipt(s.oqHome, s.repo, change.id)?.kind).toBe("complete");
    expect(statSync(homeReceiptPath(s.oqHome, s.repo, change.id)).mode & 0o777).toBe(0o600);
    expect(check()).toBe("");
  });

  it("3. a review of another branch writes no record", async () => {
    const { spawnSync } = await import("node:child_process");
    const g = (...a: string[]) => spawnSync("git", a, { cwd: s.repo, encoding: "utf8" });
    g("checkout", "-q", "-b", "other");
    writeFileSync(join(s.repo, "notes.txt"), "one\n");
    g("add", "-A");
    g("commit", "-q", "-m", "notes");
    g("checkout", "-q", "main");
    expect(await review("other")).not.toBe(2);
    expect(existsSync(join(s.oqHome, "receipts"))).toBe(false);
  });

  it("4. init prunes records older than 30 days and keeps fresh ones", async () => {
    const old = homeReceiptPath(s.oqHome, s.repo, "a".repeat(64));
    const fresh = homeReceiptPath(s.oqHome, s.repo, "b".repeat(64));
    mkdirSync(join(old, ".."), { recursive: true });
    writeFileSync(old, "{}\n");
    writeFileSync(fresh, "{}\n");
    const oldRun = homeRunPath(s.oqHome, s.repo, "20260101-000000-aaaaaaaaaaaa");
    mkdirSync(join(oldRun, ".."), { recursive: true });
    writeFileSync(oldRun, "{}\n");
    const longAgo = (Date.now() - 31 * 24 * 3600_000) / 1000;
    utimesSync(old, longAgo, longAgo);
    utimesSync(oldRun, longAgo, longAgo);
    expect(cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldRun)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("5. the legacy two-step protocol", () => {
  // `review --agent` in this home, then the findings written as the brief says.
  function agentRun(): { dir: string; changeId: string } {
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    const brief = cli(s, ["review", "--agent", "--no-install"]);
    expect(brief.status, brief.stderr).toBe(0);
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string; change_id: string };
    const dir = join(s.repo, latest.dir);
    const scan = JSON.parse(readFileSync(join(dir, "scan.json"), "utf8")) as { candidates: { id: string }[] };
    const findings = { version: 1, change_id: latest.change_id, summary: "Edits the readme.", reviewer: "subagent", findings: [], dropped: scan.candidates.map((c) => ({ candidate: c.id, reason: "Not actionable here" })) };
    writeFileSync(join(dir, "agent-findings.json"), JSON.stringify(findings));
    return { dir, changeId: latest.change_id };
  }

  it("finalize of a run this home never scanned writes no record and says so in one line", () => {
    const { changeId } = agentRun();
    const other = tempDir("oq-other-home-");
    const r = cli(s, ["review", "--finalize"], { env: { OPENQODEX_HOME: other } });
    expect(r.status).toBe(0);
    expect(readHomeReceipt(other, s.repo, changeId)).toBeNull();
    expect(r.stderr).toMatch(/not recorded for the push hooks/);
  });

  it("8. the record check takes the run files' text, the text finalize then uses, never a path read again", () => {
    const { dir, changeId } = agentRun();
    const read = (name: string) => readFileSync(join(dir, name), "utf8");
    const texts = { "manifest.json": read("manifest.json"), "scan.json": read("scan.json"), "candidates.json": read("candidates.json"), "run.json": read("run.json") };
    const manifest = JSON.parse(texts["manifest.json"]) as { config_hash: string; instructions_hash: string };
    const record = readHomeRun(s.oqHome, s.repo, dir.split("/").pop()!);
    const now = { changeId, configHash: manifest.config_hash, instructionsHash: manifest.instructions_hash, texts };
    // The files on disk swapped after the read: the check is about the text it was given.
    writeFileSync(join(dir, "scan.json"), "{}\n");
    expect(runMatches(record, now)).toBe(true);
    expect(runMatches(record, { ...now, texts: { ...texts, "scan.json": "{}\n" } })).toBe(false);
    expect(runMatches(record, { ...now, changeId: "f".repeat(64) })).toBe(false);
  });

  for (const file of ["candidates.json", "run.json"]) {
    it(`finalize of a run whose ${file} changed after review --agent writes no record`, () => {
      const { dir, changeId } = agentRun();
      writeFileSync(join(dir, file), `${readFileSync(join(dir, file), "utf8")} `);
      const r = cli(s, ["review", "--finalize"]);
      expect(readHomeReceipt(s.oqHome, s.repo, changeId)).toBeNull();
      expect(r.stderr).toMatch(/not recorded for the push hooks/);
    });
  }

  it("finalize of a run whose scan.json changed after review --agent writes no record", () => {
    const { dir, changeId } = agentRun();
    const scan = JSON.parse(readFileSync(join(dir, "scan.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "scan.json"), `${JSON.stringify({ ...scan, candidates: [], planted: true }, null, 2)}\n`);
    const r = cli(s, ["review", "--finalize"]);
    expect(readHomeReceipt(s.oqHome, s.repo, changeId)).toBeNull();
    expect(r.stderr).toMatch(/not recorded for the push hooks/);
  });
});

describe("the pushed range", () => {
  const g = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: s.repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  // A bare remote holding main.
  function withRemote(): void {
    const remote = tempDir("oq-remote-");
    spawnSync("git", ["init", "-q", "--bare", remote]);
    g("remote", "add", "origin", remote);
    g("push", "-q", "-u", "origin", "main");
  }
  // Written after the branches are made, so no commit carries it.
  function config(text: string): void {
    mkdirSync(join(s.repo, ".openqodex"), { recursive: true });
    writeFileSync(join(s.repo, ".openqodex/config.yaml"), text);
  }
  const prePush = (line: string) => cli(s, ["hook", "pre-push", "origin"], { input: `${line}\n` });

  it("6. the git hook refuses a force push over a remote commit the review never measured from", async () => {
    withRemote();
    const base = g("rev-parse", "HEAD");
    g("checkout", "-q", "-b", "remote-side");
    writeFileSync(join(s.repo, "guard.txt"), "a guard the remote holds\n");
    g("add", "-A");
    g("commit", "-q", "-m", "guard");
    g("push", "-q", "origin", "remote-side:feature");
    const remoteSha = g("rev-parse", "HEAD");
    g("checkout", "-q", "-b", "feature-local", base);
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    g("add", "-A");
    g("commit", "-q", "-m", "readme");
    const head = g("rev-parse", "HEAD");
    config("review:\n  block_on_severity: critical\n  default_base: main\n");
    expect(await review()).toBe(0);
    expect(prePush(`refs/heads/feature-local ${head} refs/heads/feature-new ${"0".repeat(40)}`).status).toBe(0);
    const forced = prePush(`refs/heads/feature-local ${head} refs/heads/feature ${remoteSha}`);
    expect(forced.status, forced.stderr).toBe(1);
    expect(forced.stderr).toContain("has not reviewed this change");
  });

  it("7. the agent hook never lets a push of another branch pass on the review of the current work", async () => {
    withRemote();
    g("branch", "unreviewed");
    g("checkout", "-q", "unreviewed");
    writeFileSync(join(s.repo, "other.txt"), "never reviewed\n");
    g("add", "-A");
    g("commit", "-q", "-m", "unreviewed");
    g("checkout", "-q", "main");
    config("review:\n  block_on_severity: critical\n");
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    g("add", "README.md");
    g("commit", "-q", "-m", "readme");
    expect(await review()).toBe(0);
    expect(check("git push")).toBe("");
    const named = check("git push origin unreviewed:main");
    expect(named, named).toContain('"permissionDecision":"deny"');
    expect(named).toContain("could not tell what this push sends");
    expect(check("git push origin +unreviewed:main")).toContain('"permissionDecision":"deny"');
  });
});

describe("9, 10. every form of push", () => {
  const g = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: s.repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  // main on a bare remote and reviewed with its uncommitted edit; a branch
  // `unreviewed` with a commit no review saw.
  async function setUp(threshold: boolean): Promise<string> {
    const remote = tempDir("oq-remote-");
    spawnSync("git", ["init", "-q", "--bare", remote]);
    g("remote", "add", "origin", remote);
    g("push", "-q", "-u", "origin", "main");
    g("checkout", "-q", "-b", "unreviewed");
    writeFileSync(join(s.repo, "other.txt"), "never reviewed\n");
    g("add", "-A");
    g("commit", "-q", "-m", "unreviewed");
    const sha = g("rev-parse", "HEAD");
    g("checkout", "-q", "main");
    mkdirSync(join(s.repo, ".openqodex"), { recursive: true });
    writeFileSync(join(s.repo, ".openqodex/config.yaml"), threshold ? "review:\n  block_on_severity: critical\n" : "");
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    g("add", "README.md");
    g("commit", "-q", "-m", "readme");
    expect(await review()).toBe(0);
    return sha;
  }
  const DENY = '"permissionDecision":"deny"';
  const COULD_NOT = "could not tell what this push sends";

  it("9. recognised lines with a review of the current work are silent, whatever git's push settings say", async () => {
    await setUp(true);
    const lines = ["git push", "git push origin", "git push origin main", "git push origin HEAD", "git push -u origin main", "git push --set-upstream origin main", "git push -f origin main", "git push --force-with-lease origin main"];
    for (const command of lines) expect(check(command), command).toBe("");
    // The agent hook reads no git push setting: the same answers with one set.
    g("config", "push.default", "matching");
    g("config", "remote.origin.push", "refs/heads/*:refs/heads/*");
    for (const command of lines) expect(check(command), command).toBe("");
  });

  it("9. a recognised line with no review of the current work asks for one, and denies under a threshold", async () => {
    await setUp(true);
    writeFileSync(join(s.repo, "README.md"), "edited after the review\n");
    const out = check("git push origin main");
    expect(out).toContain(DENY);
    expect(out).toContain("has not reviewed this change");
  });

  it("9. every other push line is one the hook cannot tell: a deny with one line under a threshold", async () => {
    await setUp(true);
    for (const command of [
      "git push origin main:main",
      "git push origin unreviewed:main",
      "git push origin +main",
      "git push --no-verify",
      "git push origin main unreviewed",
      "git push origin unreviewed",
      "git push --all origin",
      "git push --mirror origin",
      "git push --tags origin",
      "git -C . push",
      "git push origin 'main'",
      'git push origin "$BRANCH"',
      "git push && git push",
      "git add -A && git commit -qm x && git push",
      "git push; git push",
      "git push\ngit push",
      "git push origin main > /dev/null",
      "cd . && git push",
      "FOO=1 git push",
      "git push https://example.invalid/x.git main",
    ]) {
      const out = check(command);
      expect(out, command).toContain(DENY);
      expect(out, command).toContain(COULD_NOT);
    }
  });

  it("9. without a threshold, a line the hook cannot tell prints the line and allows", async () => {
    await setUp(false);
    const out = check("git push --mirror origin");
    expect(out).toContain(COULD_NOT);
    expect(out).not.toContain(DENY);
  });

  it("11. an unreadable config is a tool error: both hooks allow, with one line on stderr", async () => {
    await setUp(true);
    writeFileSync(join(s.repo, ".openqodex/config.yaml"), "review: [\n");
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin unreviewed:main" }, cwd: s.repo });
    const agent = cli(s, ["hook", "check"], { input });
    expect(agent.status).toBe(0);
    expect(agent.stdout).toBe("");
    expect(agent.stderr.trim().split("\n")).toHaveLength(1);
    const zero = "0".repeat(40);
    // Exit 2: the installed hook script maps it to letting the push through.
    // No commit holds a config here, so none chose blocking; 15 has the
    // repo whose committed config blocks.
    expect(cli(s, ["hook", "pre-push", "origin"], { input: `refs/heads/x ${g("rev-parse", "HEAD")} refs/heads/x ${zero}\n` }).status).toBe(2);
  });

  it("10. the git hook refuses a push where one range of several is unreviewed, and skips a deletion", async () => {
    const sha = await setUp(true);
    const head = g("rev-parse", "HEAD");
    const base = g("rev-parse", "origin/main");
    const zero = "0".repeat(40);
    // The reviewed edit, now committed, is the same change: its range passes.
    expect(cli(s, ["hook", "pre-push", "origin"], { input: `refs/heads/main ${head} refs/heads/main ${base}\n` }).status).toBe(0);
    expect(cli(s, ["hook", "pre-push", "origin"], { input: `(delete) ${zero} refs/heads/old ${base}\n` }).status).toBe(0);
    const both = cli(s, ["hook", "pre-push", "origin"], { input: `refs/heads/main ${head} refs/heads/main ${base}\nrefs/heads/unreviewed ${sha} refs/heads/main ${base}\n` });
    expect(both.status).toBe(1);
  });

  it("14. the git hook passes a push that sends nothing, whatever the work tree holds", async () => {
    await setUp(true);
    writeFileSync(join(s.repo, "README.md"), "unreviewed edit\n");
    const r = cli(s, ["hook", "pre-push", "origin"], { input: "" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });
});

// 15. A broken config in the work tree makes the git hook's lookup fail
// (exit 2), which the installed hook lets through: a blocking repo is
// bypassed by a push that breaks its config (issue 339). The verdict then
// comes from the config in the base of each pushed range, the commit the
// remote has. A repo whose history never validly chose blocking keeps exit 2.
describe("15. a broken config in the work tree", () => {
  const g = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: s.repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const BLOCKS = "review:\n  block_on_severity: critical\n";
  const LAX = "review:\n  severity_threshold: minor\n";
  const MALFORMED = "review: [\n";
  const put = (path: string, text: string) => {
    mkdirSync(join(s.repo, path, ".."), { recursive: true });
    writeFileSync(join(s.repo, path), text);
  };
  // Commits `files` on main, puts main on a bare remote, then commits an
  // unreviewed code change on top.
  function based(files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) put(path, text);
    commitAll();
    const remote = tempDir("oq-remote-");
    spawnSync("git", ["init", "-q", "--bare", remote]);
    g("remote", "add", "origin", remote);
    g("push", "-q", "-u", "origin", "main");
    writeFileSync(join(s.repo, "code.txt"), "never reviewed\n");
    commitAll();
  }
  const pushMain = () => cli(s, ["hook", "pre-push", "origin"], { input: `refs/heads/main ${g("rev-parse", "HEAD")} refs/heads/main ${g("rev-parse", "origin/main")}\n` });

  it("a blocking base and a work tree .openqodex that is a symbolic link: exit 1, naming the link", () => {
    based({ ".openqodex/config.yaml": BLOCKS });
    rmSync(join(s.repo, ".openqodex"), { recursive: true });
    symlinkSync("elsewhere", join(s.repo, ".openqodex"));
    commitAll();
    const r = pushMain();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(".openqodex is a symbolic link");
    expect(r.stderr).toContain("blocks a push without a passing review");
    expect(r.stderr).toContain("push again");
  });

  for (const [what, text, says] of [
    ["malformed YAML", MALFORMED, "not valid YAML"],
    ["a bad block_on_severity value", "review:\n  block_on_severity: huge\n", "review.block_on_severity"],
  ]) {
    it(`a blocking base and ${what} in the work tree: exit 1, naming it`, () => {
      based({ ".openqodex/config.yaml": BLOCKS });
      put(".openqodex/config.yaml", text);
      const r = pushMain();
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain(says);
    });
  }

  it("a base that never chose blocking and malformed YAML in the work tree: exit 2, as before", () => {
    based({ ".openqodex/config.yaml": LAX });
    put(".openqodex/config.yaml", MALFORMED);
    const r = pushMain();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("openqodex hook pre-push: .openqodex/config.yaml: not valid YAML");
  });

  it("a base config that is itself malformed, even one naming block_on_severity, does not block: exit 2", () => {
    based({ ".openqodex/config.yaml": `${BLOCKS}  exclude: [\n` });
    const r = pushMain();
    expect(r.status).toBe(2);
  });

  it("a base whose .openqodex is a symbolic link does not block, though its legacy file does: exit 2", () => {
    symlinkSync("elsewhere", join(s.repo, ".openqodex"));
    based({ ".openqodex.yaml": BLOCKS });
    const r = pushMain();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(".openqodex is a symbolic link");
  });

  it("two ranges, one whose base blocks and one whose base does not, exit 1 in either order", () => {
    based({ ".openqodex/config.yaml": LAX });
    const lax = g("rev-parse", "HEAD");
    g("push", "-q", "origin", "HEAD:lax");
    put(".openqodex/config.yaml", BLOCKS);
    commitAll();
    g("push", "-q", "origin", "HEAD:strict");
    const strict = g("rev-parse", "HEAD");
    writeFileSync(join(s.repo, "more.txt"), "never reviewed\n");
    commitAll();
    const strictWork = g("rev-parse", "HEAD");
    g("checkout", "-q", "-b", "lax-work", lax);
    writeFileSync(join(s.repo, "other.txt"), "never reviewed\n");
    commitAll();
    const laxWork = g("rev-parse", "HEAD");
    put(".openqodex/config.yaml", MALFORMED);
    const laxLine = `refs/heads/lax-work ${laxWork} refs/heads/lax ${lax}`;
    const strictLine = `refs/heads/main ${strictWork} refs/heads/strict ${strict}`;
    expect(cli(s, ["hook", "pre-push", "origin"], { input: `${laxLine}\n` }).status).toBe(2);
    expect(cli(s, ["hook", "pre-push", "origin"], { input: `${laxLine}\n${strictLine}\n` }).status).toBe(1);
    expect(cli(s, ["hook", "pre-push", "origin"], { input: `${strictLine}\n${laxLine}\n` }).status).toBe(1);
  });

  it("a new branch with no base to measure from keeps today's exit 2", () => {
    based({ ".openqodex/config.yaml": BLOCKS });
    put(".openqodex/config.yaml", MALFORMED);
    const r = cli(s, ["hook", "pre-push", "origin"], { input: `refs/heads/main ${g("rev-parse", "HEAD")} refs/heads/fresh ${"0".repeat(40)}\n` });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not valid YAML");
  });

  it("a base with only the legacy .openqodex.yaml blocking, and a broken .openqodex/config.yaml in the work tree: exit 1", () => {
    based({ ".openqodex.yaml": BLOCKS });
    put(".openqodex/config.yaml", MALFORMED);
    expect(pushMain().status).toBe(1);
  });

  it("a base with a valid .openqodex/config.yaml that does not block beside a legacy file that does: the folder file wins, exit 2", () => {
    based({ ".openqodex/config.yaml": LAX, ".openqodex.yaml": BLOCKS });
    put(".openqodex/config.yaml", MALFORMED);
    expect(pushMain().status).toBe(2);
  });
});
