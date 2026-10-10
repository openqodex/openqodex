// `init` ends with a review: of the change when there is one, else one
// question (or, without a terminal, the three commands). The closing step
// runs in-process after the install boundary is released; its own tests
// give it the one stand-in, a reviewer driver object, and the subprocess
// tests run the built CLI with no reviewer on PATH.
//
// Ways it could fail, written before the code:
//  1. `init` with a change prints no receipt, or a review whose report names no reviewer.
//  2. `init` fails (exit not 0) because the review was unavailable.
//  3. `init --yes`, or init without a terminal, with no change waits for an
//     answer instead of printing the three commands.
//  4. A review started by init re-enters init, or downloads a scanner the
//     repo's config switches off.
//  5. `--no-review` still reviews.
//  6. A dry run or an uninstall reviews.
//  7. A developer's own earlier edit to a file init then wrote to (CLAUDE.md)
//     is left out of the review, or init's own addition is reviewed with it.
//  8. A file init wrote inside the git folder (the pre-push hook, the
//     exclude file) is handed to the change source, git refuses to stage it,
//     and the review after init never runs.
//  9. A work tree nested inside its bare repository (/x/repo.git/main) lies
//     under the shared git folder, so no file in it counts as a work tree
//     file and the files init writes enter the review after init.
// 10. Answering no to "Write these files?" still runs the review, which
//     writes the repo folder and the report: a cancelled install goes on.
// 12. The first review runs with downloads off while init's downloads are
//     still going, so it has the fewest scanners of any review; or it waits
//     on them without a bound; or it does not name the ones still pending.
// 14. A declined install still runs init's cleanup: old locks removed before
//     the question, old runtimes and receipts pruned after the no.
// 13. A run with no terminal, no agent marker and no --yes has no consent,
//     yet a run with no file to write still saves changed choices to the
//     record and starts the review.
// 11. init says it is set up when no reviewer can start, then the first
//     review fails; or it ends without saying how the first review ended
//     (finished, incomplete, skipped, unavailable) and which reviewer was found;
//     or a review that ran but could not write report.html is called skipped,
//     with "nothing to review".
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitDirs, gitPath, inWorkTree, repoRootOf } from "../src/agents/git.js";
import { reviewAfterInit } from "../src/commands/init-review.js";
import { DEPTH_ENV } from "@openqodex/review";
import type { ReviewerDriver, ReviewerSession, Turn } from "@openqodex/review";
import { agentFreePath, cli, inTerminal, sandbox, snapshot } from "./init-helpers.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

// A repo config that switches off the two scanners a text file calls for, so
// an init or a review starts no download and waits on none. The toolchain
// finds the built CLI and installs for real, so a test that wants no network
// carries this config.
const NO_DOWNLOADS = { ".openqodex/config.yaml": "scanners:\n  disable: [semgrep, gitleaks]\n" };

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function repo(change: boolean): string {
  const dir = tempDir("oq-init-review-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  for (const [path, text] of Object.entries(NO_DOWNLOADS)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  if (change) writeFileSync(join(dir, "notes.txt"), "one line\n");
  return dir;
}

// The model provider stand-in: an empty, valid submission after reading the change.
function fake(): ReviewerDriver & { started: number } {
  const driver = {
    name: "claude",
    traced: true,
    started: 0,
    async detect() {
      return { ok: true as const, version: "9.9.9", bin: "/fake/claude" };
    },
    start(): ReviewerSession {
      driver.started++;
      return {
        pid: 4242,
        async send(text: string): Promise<Turn> {
          const id = /`change_id`: `([0-9a-f]{12})`/.exec(text)?.[1] ?? "missing";
          const finalText = JSON.stringify({ version: 2, change_id: id, summary: "Adds a notes file.", findings: [], dropped: [] });
          return { finalText, calls: [{ tool: "Read", input: { file_path: "notes.txt" }, ok: true, read: { path: "notes.txt", start: 1, lines: 1 } }], usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: null }, sessionId: "fake", failure: null };
        },
        async close() {},
      };
    },
  };
  return driver;
}

let out: string;
let err: string;
beforeEach(() => {
  out = "";
  err = "";
  vi.stubEnv("OPENQODEX_HOME", tempDir("oq-init-review-home-"));
  vi.stubEnv(DEPTH_ENV, "");
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("the review init ends with", () => {
  it("1. with a change, prints the receipt of a complete review, whose report names the reviewer", async () => {
    const driver = fake();
    await reviewAfterInit({ repoRoot: repo(true), runner: "openqodex", interactive: false, drivers: [driver] });
    expect(driver.started).toBe(1);
    expect(out).toContain("Passed");
    const md = /^Markdown: (\/.+\/report\.md)$/m.exec(out)?.[1];
    expect(md, out).toBeDefined();
    expect(readFileSync(md!, "utf8")).toContain("Reviewer: claude 9.9.9");
    expect(out).toContain("First review: finished.");
  });

  it("11. a review whose answer never passes the checks ends as First review: incomplete", async () => {
    const driver = fake();
    const start = driver.start.bind(driver);
    driver.start = (opts) => {
      const session = start(opts);
      return { ...session, send: async (text: string) => ({ ...(await session.send(text)), finalText: "not an answer" }) };
    };
    await expect(reviewAfterInit({ repoRoot: repo(true), runner: "openqodex", interactive: false, drivers: [driver] })).resolves.toBe("incomplete");
    expect(out).toContain("First review: incomplete.");
  });

  it("11. a first review that ran but could not write report.html ends as First review: incomplete with the reason, not skipped", async () => {
    const dir = repo(true);
    const driver = fake();
    const start = driver.start.bind(driver);
    driver.start = (opts) => {
      const session = start(opts);
      return {
        ...session,
        send: async (text: string) => {
          // A folder where report.html goes, in this run's folder: the page cannot be written.
          const reviews = join(dir, ".openqodex", "reviews");
          const run = readdirSync(reviews).sort().pop()!;
          mkdirSync(join(reviews, run, "report.html"), { recursive: true });
          return session.send(text);
        },
      };
    };
    await expect(reviewAfterInit({ repoRoot: dir, runner: "openqodex", interactive: false, drivers: [driver] })).resolves.toBe("incomplete");
    expect(out).toContain("First review: incomplete (report.html could not be written).");
    expect(out).not.toContain("nothing to review");
  });

  it("12. joins a scanner download in progress for its bound, then names it as still downloading", async () => {
    const dir = repo(false);
    writeFileSync(join(dir, "deploy.sh"), "#!/bin/sh\necho hi\n");
    // Every tool held by a live process (this one): the review waits on the
    // download as on init's, and starts none of its own.
    const tools = Object.keys((JSON.parse(readFileSync(new URL("../../scanners/toolchain.json", import.meta.url), "utf8")) as { tools: Record<string, unknown> }).tools);
    for (const tool of tools) {
      mkdirSync(join(process.env.OPENQODEX_HOME!, "tools", tool), { recursive: true });
      writeFileSync(join(process.env.OPENQODEX_HOME!, "tools", tool, ".lock"), `${process.pid} test\n`);
    }
    const started = Date.now();
    const ended = await reviewAfterInit({ repoRoot: dir, runner: "openqodex", interactive: false, drivers: [fake()], installWaitMs: 1500 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(ended).toBe("finished");
    expect(out).toMatch(/Still downloading: [^\n]*shellcheck/);
    expect(out + err).not.toContain("installs are off");
  });

  it("3. with no change and no terminal, prints the three commands and asks nothing", async () => {
    const driver = fake();
    const ask = vi.fn();
    await reviewAfterInit({ repoRoot: repo(false), runner: "openqodex", interactive: false, drivers: [driver], ask });
    expect(ask).not.toHaveBeenCalled();
    expect(driver.started).toBe(0);
    expect(out).toContain("openqodex review --all");
    expect(out).toContain("openqodex review '#<number>'");
    expect(out).toContain("openqodex review <branch>");
    expect(out).toContain("First review: skipped");
  });

  it("with no change and the answer not now, reviews nothing", async () => {
    const driver = fake();
    await reviewAfterInit({ repoRoot: repo(false), runner: "openqodex", interactive: true, drivers: [driver], ask: async () => null });
    expect(driver.started).toBe(0);
    expect(out).toContain("First review: skipped");
  });

  it("2. a review that cannot start is reported and never throws", async () => {
    const none: ReviewerDriver = { name: "claude", traced: true, detect: async () => ({ ok: false, missing: "claude is not installed", fix: "install it" }), start: () => { throw new Error("no"); } };
    await expect(reviewAfterInit({ repoRoot: repo(true), runner: "openqodex", interactive: false, drivers: [none] })).resolves.toBe("unavailable");
    expect(err).toContain("Full review unavailable");
    expect(out).toContain("First review: unavailable.");
  });
});

// The model provider stand-in for a subprocess run: a `claude` on PATH that
// answers detection as Claude Code does, then answers every message with an
// empty, valid submission for the change id the brief names.
function standIn(): string {
  const dir = tempDir("oq-init-review-bin-");
  writeFileSync(
    join(dir, "claude"),
    [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }",
      "if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }",
      "let id = 'missing';",
      "const say = (e) => process.stdout.write(JSON.stringify(e) + '\\n');",
      "say({ type: 'system', subtype: 'init', session_id: 'fake', tools: ['Glob', 'Grep', 'Read'], mcp_servers: [] });",
      "let buf = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buf += chunk;",
      "  for (let nl = buf.indexOf('\\n'); nl !== -1; nl = buf.indexOf('\\n')) {",
      "    const text = JSON.parse(buf.slice(0, nl)).message.content;",
      "    buf = buf.slice(nl + 1);",
      "    id = /`change_id`: `([0-9a-f]{12})`/.exec(text)?.[1] ?? id;",
      "    const result = JSON.stringify({ version: 2, change_id: id, summary: 'Adds a notes file.', findings: [], dropped: [] });",
      "    say({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result });",
      "  }",
      "});",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

describe("init as a subprocess", () => {
  it("2, 4, 11. with a change and no reviewer: exit 0, names each missing reviewer and its fix, starts no review, prints the plan once", () => {
    const s = sandbox({ "README.md": "hello\n", ...NO_DOWNLOADS });
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo"], { review: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("No reviewer can start yet");
    expect(r.stdout).toContain("claude: Claude Code (claude) is not on PATH; install Claude Code and log in");
    expect(r.stdout).toContain("codex: Codex (codex) is not on PATH");
    expect(r.stdout).toContain(`'${join(s.oqHome, "bin/openqodex")}' review --agent`);
    expect(r.stdout).toContain("First review: unavailable.");
    expect(r.stdout).not.toContain("Reviewing your change now");
    expect(r.stdout.match(/install plan/g)).toHaveLength(1);
    expect(r.stderr + r.stdout).not.toMatch(/Installing the scanners .* first use|downloading/i);
  });

  it("11. with --no-review and no reviewer, still names what is missing, and says the review was skipped", () => {
    const s = sandbox({ "README.md": "hello\n", ...NO_DOWNLOADS });
    const r = cli(s, ["init", "--yes", "--no-review", "--agent", "claude-code", "--hook", "none", "--no-repo"], { review: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("No reviewer can start yet");
    expect(r.stdout).toContain("First review: skipped (--no-review).");
  });

  it("8, 11. with the git pre-push hook and an exclude line written, the review after init still runs, names the reviewer found and finishes", () => {
    const s = sandbox({ "README.md": "hello\n", ...NO_DOWNLOADS });
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--agent", "cursor", "--hook", "pre-push", "--no-repo"], { env: { PATH: `${standIn()}${delimiter}${agentFreePath()}` }, review: true });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(s.repo, ".git/hooks/pre-push"))).toBe(true);
    expect(readFileSync(join(s.repo, ".git/info/exclude"), "utf8")).toContain(".cursor");
    expect(r.stderr).not.toContain("did not run");
    expect(r.stdout).toContain("Reviewer ready: Claude Code 9.9.9");
    const md = /^Markdown: (\/.+\/report\.md)$/m.exec(r.stdout)?.[1];
    expect(md, r.stdout).toBeDefined();
    expect(readFileSync(md!, "utf8")).toContain("Reviewer: claude 9.9.9");
    expect(r.stdout).toContain("First review: finished.");
  });

  it("3. --yes with no change prints the three commands and exits without waiting", () => {
    const s = sandbox({ "README.md": "hello\n", ...NO_DOWNLOADS });
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo"], { env: { PATH: `${standIn()}${delimiter}${agentFreePath()}` }, review: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("No change to review here");
    expect(r.stdout).toContain("review <branch>");
  });

  it("5. --no-review skips the review", () => {
    const s = sandbox({ "README.md": "hello\n", ...NO_DOWNLOADS });
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    const r = cli(s, ["init", "--yes", "--no-review", "--agent", "claude-code", "--hook", "none", "--no-repo"], { env: { PATH: `${standIn()}${delimiter}${agentFreePath()}` }, review: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("Full review unavailable");
    expect(r.stdout).not.toContain("Reviewing your change now");
  });

  it("6. a dry run and an uninstall review nothing", () => {
    const s = sandbox({ "README.md": "hello\n", ...NO_DOWNLOADS });
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    for (const extra of [["--dry-run"], ["--uninstall"]]) {
      const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo", ...extra], { review: true });
      expect(r.stderr).not.toContain("Full review unavailable");
      expect(r.stdout).not.toContain("Reviewing your change now");
      expect(r.stdout).not.toContain("No change to review here");
    }
  });
});

describe("10. a declined install", () => {
  it("writes nothing and starts no review, with a change waiting", () => {
    const s = sandbox({ "README.md": "hello\n", ...NO_DOWNLOADS });
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    const before = snapshot(s);
    const r = inTerminal(s, ["init", "--agent", "claude-code"], [["Write these files?", "n"]], { review: true });
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("Nothing was written.");
    expect(r.stdout).not.toContain("Reviewing your change now");
    expect(r.stdout).not.toContain("Full review unavailable");
    expect(snapshot(s)).toEqual(before);
  });

  it("14. on a home that holds an install, removes no lock, old runtime or old receipt", () => {
    const s = sandbox({ "README.md": "hello\n", ...NO_DOWNLOADS });
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    // What init's cleanup removes when it runs: the locks of versions before
    // the commit boundary, a runtime older than 7 days, a receipt older than 30.
    for (const name of ["install.lock", "update.lock", "update.json.lock"]) writeFileSync(join(s.oqHome, name), "old\n");
    const oldRuntime = join(s.oqHome, "runtime", "0.0.1");
    mkdirSync(oldRuntime, { recursive: true });
    writeFileSync(join(oldRuntime, "package.json"), JSON.stringify({ name: "openqodex", version: "0.0.1" }));
    const oldReceipt = join(s.oqHome, "receipts", "some-repo", "old.json");
    mkdirSync(join(oldReceipt, ".."), { recursive: true });
    writeFileSync(oldReceipt, "{}\n");
    const longAgo = new Date(Date.now() - 60 * 24 * 3600_000);
    utimesSync(oldRuntime, longAgo, longAgo);
    utimesSync(oldReceipt, longAgo, longAgo);
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    const before = snapshot(s);
    // A second agent gives the plan something to write, so it asks.
    const r = inTerminal(s, ["init", "--agent", "claude-code", "--agent", "codex"], [["Write these files?", "n"]], { review: true });
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("Nothing was written.");
    expect(snapshot(s)).toEqual(before);
  });
});

describe("13. no consent", () => {
  it("with no terminal, no agent and no --yes, a run with nothing to write records nothing and starts no review", () => {
    const s = sandbox({ "README.md": "hello\n", ...NO_DOWNLOADS });
    const path = `${standIn()}${delimiter}${agentFreePath()}`;
    expect(cli(s, ["init", "--yes", "--agent", "claude-code", "--no-repo"], { env: { PATH: path } }).status).toBe(0);
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    const record = readFileSync(join(s.oqHome, "install.json"), "utf8");
    // --hook none changes only a recorded choice: no file to write.
    const r = cli(s, ["init", "--hook", "none", "--agent", "claude-code"], { env: { PATH: path }, review: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Nothing to change");
    expect(readFileSync(join(s.oqHome, "install.json"), "utf8")).toBe(record);
    expect(r.stdout).not.toContain("Reviewing your change now");
    expect(existsSync(join(s.repo, ".openqodex/reviews"))).toBe(false);
    expect(r.stdout).toContain("First review: skipped");
  });
});

describe("7. what init wrote is not part of the first review", () => {
  // A stand-in that keeps what the snapshot held when it started.
  function seeing(path: string): ReviewerDriver & { seen: (string | null)[] } {
    const d = fake() as ReviewerDriver & { seen: (string | null)[]; started: number };
    d.seen = [];
    const start = d.start.bind(d);
    d.start = (opts) => {
      d.seen.push(existsSync(join(opts.snapshotDir, path)) ? readFileSync(join(opts.snapshotDir, path), "utf8") : null);
      return start(opts);
    };
    return d;
  }

  it("reviews the developer's own edit to CLAUDE.md without the section init appended", async () => {
    const dir = repo(false);
    writeFileSync(join(dir, "CLAUDE.md"), "# Team\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "Claude file");
    const mine = "# Team\n\nUse tabs.\n";
    writeFileSync(join(dir, "CLAUDE.md"), mine);
    appendFileSync(join(dir, "CLAUDE.md"), "\n<!-- openqodex -->\nReview before you push.\n");
    const driver = seeing("CLAUDE.md");
    await reviewAfterInit({ repoRoot: dir, runner: "openqodex", interactive: false, drivers: [driver], initFiles: new Map([[join(dir, "CLAUDE.md"), mine]]) });
    expect(driver.seen).toEqual([mine]);
  });

  it("a file init created is the whole change: nothing is reviewed", async () => {
    const dir = repo(false);
    writeFileSync(join(dir, "AGENTS.md"), "<!-- openqodex -->\nReview before you push.\n");
    const driver = seeing("AGENTS.md");
    await reviewAfterInit({ repoRoot: dir, runner: "openqodex", interactive: false, drivers: [driver], initFiles: new Map([[join(dir, "AGENTS.md"), null]]) });
    expect(driver.seen).toEqual([]);
    expect(out).toContain("No change to review here");
  });
});

describe("which files init writes count as work tree files", () => {
  it("9. a work tree nested inside its bare repository still counts its own files, and the git folders stay out", async () => {
    const root = realpathSync(tempDir("oq-nested-bare-"));
    const seed = join(root, "seed");
    git(root, "init", "-q", "-b", "main", seed);
    writeFileSync(join(seed, "README.md"), "hello\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "Base");
    const bare = join(root, "repo.git");
    git(root, "clone", "-q", "--bare", seed, bare);
    git(bare, "worktree", "add", "-q", join(bare, "main"), "main");
    const repoRoot = (await repoRootOf(join(bare, "main")))!;
    const folders = await gitDirs(repoRoot);
    expect(folders.some((dir) => repoRoot.startsWith(`${dir}/`))).toBe(true);
    expect(inWorkTree(repoRoot, folders, join(repoRoot, "CLAUDE.md"))).toBe(true);
    expect(inWorkTree(repoRoot, folders, join(bare, "hooks", "pre-push"))).toBe(false);
    expect(inWorkTree(repoRoot, folders, await gitPath(repoRoot, "hooks/pre-push"))).toBe(false);
  });

  it("9. in a plain repository the files in .git do not count", async () => {
    const dir = realpathSync(repo(false));
    const folders = await gitDirs(dir);
    expect(inWorkTree(dir, folders, join(dir, "CLAUDE.md"))).toBe(true);
    expect(inWorkTree(dir, folders, join(dir, ".git", "info", "exclude"))).toBe(false);
  });
});
