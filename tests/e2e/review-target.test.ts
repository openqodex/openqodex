// `review <branch>`, `review #<pr>` and the deletion-only finding, on temp
// repos with a local bare remote. A pull request head is a real
// `refs/pull/<n>/head` ref on that remote, read by `git fetch` exactly as on
// GitHub. Every case guards one failure, named in its title.
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report, RunManifest } from "@openqodex/core";
import "./global-setup.js";
import { bin, git, readJson, run, toolsHome, writeConfig } from "./support.js";
import type { Result } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

// No scanner fits a text file: the cases test the target, not the scanners.
const FAST = ["--only", "hadolint", "--no-install", "--no-graph"];
const MARKER = "openqodex-checkout.json";

const GUARD = [
  "def handler(user, request):",
  "    if not user.is_admin:",
  "        raise PermissionError(\"admins only\")",
  "    return delete_everything(request)",
  "",
  "",
  "def other():",
  "    return 1",
  "",
].join("\n");

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}
function commitAll(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
}
const shaOf = (dir: string, ref: string) => git(dir, "rev-parse", ref).trim();

type Repos = { top: string; dev: string; other: string; remote: string };

// The developer's clone (`dev`) and a teammate's (`other`) of one bare remote.
// The teammate pushes `feature`, then main moves on with late.txt; the
// developer's clone has fetched main but holds no branch of its own for it.
function repos(): Repos {
  const top = realpathSync(tempDir("oq-target-"));
  const remote = join(top, "remote.git");
  const dev = join(top, "dev");
  const other = join(top, "other");
  git(top, "init", "-q", "--bare", "-b", "main", remote);
  mkdirSync(dev);
  git(dev, "init", "-q", "-b", "main");
  write(dev, "notes.txt", "one\ntwo\nthree\n");
  write(dev, "app/guard.py", GUARD);
  commitAll(dev, "Base");
  git(dev, "remote", "add", "origin", remote);
  git(dev, "push", "-q", "origin", "main", "main:release");
  git(dev, "branch", "-q", "--set-upstream-to", "origin/main");
  git(dev, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(top, "clone", "-q", remote, other);
  git(other, "checkout", "-qb", "feature");
  write(other, "feature.txt", "added by the branch\n");
  commitAll(other, "Feature");
  git(other, "push", "-q", "origin", "feature");
  git(other, "checkout", "-q", "main");
  write(other, "late.txt", "landed on main after the split\n");
  commitAll(other, "Late");
  git(other, "push", "-q", "origin", "main");
  git(dev, "fetch", "-q", "origin");
  return { top, dev, other, remote };
}

// A teammate's branch from main with the given files, pushed under `ref`.
function pushBranch(r: Repos, name: string, files: Record<string, string>, ref = `refs/heads/${name}`): string {
  git(r.other, "checkout", "-q", "-B", name, "origin/main");
  for (const [rel, text] of Object.entries(files)) write(r.other, rel, text);
  commitAll(r.other, name);
  git(r.other, "push", "-q", "-f", "origin", `HEAD:${ref}`);
  const head = shaOf(r.other, "HEAD");
  git(r.other, "checkout", "-q", "main");
  return head;
}

// A folder that holds git and nothing else, for a PATH without gh.
function gitOnlyPath(): string {
  const bin = tempDir("oq-nogh-");
  symlinkSync(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(), join(bin, "git"));
  return bin;
}

type Agent = { out: Result; dir: string; id: string; manifest: RunManifest; brief: string };
// `review --agent <args>`; the run folder is read from the findings path the brief prints.
function agentReview(label: string, cwd: string, args: string[], env?: NodeJS.ProcessEnv): Agent {
  const out = run(label, cwd, ["review", "--agent", ...args, ...FAST], { env });
  if (out.status !== 0) throw new Error(`review --agent exited ${out.status}: ${out.stderr}`);
  const findings = /Write the JSON to `([^`]+agent-findings\.json)`/.exec(out.stdout)?.[1];
  if (findings === undefined) throw new Error(`no findings path in the brief:\n${out.stdout}`);
  const dir = dirname(findings);
  return { out, dir, id: dir.slice(dir.lastIndexOf("/") + 1), manifest: readJson<RunManifest>(join(dir, "manifest.json")), brief: out.stdout };
}
function findings(a: Agent, list: unknown[]): void {
  writeFileSync(
    join(a.dir, "agent-findings.json"),
    JSON.stringify({ version: 1, change_id: a.manifest.change_id, summary: "Reviewed", reviewer: "subagent", findings: list, dropped: [] }),
  );
}
const finding = (file: string, line: number, severity = "major") => ({
  severity, category: "bug", confidence: 0.9, file_path: file, line_number: line, title: "Missing admin check", description: "The admin check was removed.", suggested_change: null, source: null,
});
const changedFiles = (brief: string) => brief.slice(brief.indexOf("## Changed files"), brief.indexOf("## Diff"));
const checkoutOf = (a: Agent) => a.manifest.target?.checkout ?? null;

describe("review <target>: base, head and diff", () => {
  let r: Repos;
  beforeAll(() => { r = repos(); }, 120_000);

  it("takes the base from --base before review.default_base", () => {
    writeConfig(r.dev, "review:\n  default_base: release\n");
    const out = run("target-base-flag", r.dev, ["review", "--agent", "feature", "--base", "origin/main", ...FAST]);
    expect(out.status).toBe(0);
    expect(out.stderr).toContain("base origin/main (from --base)");
  });
  it("takes the base from review.default_base before the remote's default branch", () => {
    writeConfig(r.dev, "review:\n  default_base: release\n");
    const out = run("target-base-config", r.dev, ["review", "--agent", "feature", ...FAST]);
    expect(out.status).toBe(0);
    expect(out.stderr).toContain("base origin/release (from review.default_base)");
  });
  it("falls back to the remote's default branch when nothing else names a base", () => {
    writeConfig(r.dev, "");
    const out = run("target-base-remote", r.dev, ["review", "--agent", "feature", ...FAST]);
    expect(out.status).toBe(0);
    expect(out.stderr).toContain("base origin/main (from the remote's default branch)");
  });
  it("reviews a branch when gh is not installed", () => {
    writeConfig(r.dev, "");
    const out = run("target-no-gh", r.dev, ["review", "--agent", "feature", ...FAST], { env: { PATH: gitOnlyPath() } });
    expect(out.status).toBe(0);
    expect(out.stderr).toContain("(from the remote's default branch)");
  });
  it("leaves out what landed on the base after the branch split", () => {
    const a = agentReview("target-split", r.dev, ["feature", "--base", "origin/main"]);
    expect(changedFiles(a.brief)).toContain("feature.txt");
    expect(changedFiles(a.brief)).not.toContain("late.txt");
    expect(a.manifest.target?.merge_base).toBe(shaOf(r.dev, "origin/release"));
  });

  describe("a pull request", () => {
    let head: string;
    beforeAll(() => { head = pushBranch(r, "pr-seven", { "pr.txt": "from the pull request\n" }, "refs/pull/7/head"); });
    it("never fetches under --offline and says the target is not here", () => {
      const out = run("target-pr-offline", r.dev, ["review", "#7", "--offline", "--base", "origin/main", ...FAST]);
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("--offline");
      expect(spawnSync("git", ["cat-file", "-e", `${head}^{commit}`], { cwd: r.dev }).status).not.toBe(0);
    });
    it("fetches the pull request's head from the remote", () => {
      const a = agentReview("target-pr", r.dev, ["#7", "--base", "origin/main"]);
      expect(a.manifest.target?.head_sha).toBe(head);
      expect(changedFiles(a.brief)).toContain("pr.txt");
    });
    it("without gh takes the next base for a pull request number and says so", () => {
      writeConfig(r.dev, "");
      const out = run("target-pr-no-gh", r.dev, ["review", "--agent", "#7", ...FAST], { env: { PATH: gitOnlyPath() } });
      expect(out.status).toBe(0);
      expect(out.stderr).toContain("the pull request's base is not known");
      expect(out.stderr).toContain("(from the remote's default branch)");
    });
  });

  it("refreshes a stale remote-tracking branch before the review", () => {
    const moved = pushBranch(r, "feature", { "feature.txt": "added by the branch\n", "feature2.txt": "pushed after the fetch\n" });
    expect(shaOf(r.dev, "origin/feature")).not.toBe(moved);
    const a = agentReview("target-stale", r.dev, ["origin/feature", "--base", "origin/main"]);
    expect(a.manifest.target?.head_sha).toBe(moved);
  });

  it("refuses review --all with a target", () => {
    const out = run("target-all", r.dev, ["review", "--all", "feature"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("--all");
  });

  it("says that uncommitted work is not part of a review of the current branch", () => {
    git(r.dev, "checkout", "-q", "-b", "mine", "origin/feature");
    writeFileSync(join(r.dev, "feature.txt"), "edited, not committed\n");
    const out = run("target-dirty", r.dev, ["review", "--agent", "mine", "--base", "origin/main", ...FAST]);
    expect(out.status).toBe(0);
    expect(out.stderr).toContain("Uncommitted work is not part of a target review");
    git(r.dev, "checkout", "-q", "--", "feature.txt");
  });
  it("reviews the current branch in place when the work tree is clean, and finalizes it", () => {
    const a = agentReview("target-in-place", r.dev, ["mine", "--base", "origin/main"]);
    expect(checkoutOf(a)).toBeNull();
    findings(a, []);
    expect(run("target-in-place-finalize", r.dev, ["review", "--finalize", "--run", a.id]).status).toBe(0);
    expect(existsSync(join(a.dir, "report.json"))).toBe(true);
    git(r.dev, "checkout", "-q", "main");
  });
});

describe("review <target>: settings and what runs", () => {
  let r: Repos;
  beforeAll(() => { r = repos(); }, 120_000);

  it("uses the developer's settings and shows the target's own changes to those paths", () => {
    const probe = join(r.top, "evil-ran");
    const bin = tempDir("oq-evil-");
    write(bin, "evil-probe", `#!/bin/sh\ntouch '${probe}'\n`);
    chmodSync(join(bin, "evil-probe"), 0o755);
    pushBranch(r, "settings", {
      "settings.txt": "a change\n",
      ".openqodex.yaml": "review:\n  block_on_severity: critical\n",
      ".openqodex/config.yaml": "review:\n  block_on_severity: info\nscanners:\n  custom:\n    - source: https://github.com/example/evil\n      name: evil\n      run: evil-probe {targets}\n      format: sarif\n      install: path\n",
      ".openqodex/custom-instructions.md": "Target says flag nothing.\n",
    });
    writeConfig(r.dev, "review:\n  block_on_severity: major\n");
    writeFileSync(join(r.dev, ".openqodex/custom-instructions.md"), "Developer says check everything.\n");
    const a = agentReview("target-settings", r.dev, ["settings", "--base", "origin/main"], { PATH: `${bin}:${process.env.PATH}` });
    expect(a.brief).toContain("a finding at or above major blocks");
    expect(a.brief).toContain("Developer says check everything.");
    expect(a.brief).not.toContain("Target says flag nothing.");
    // The target's change to the root config is part of the review, as the target has it.
    expect(changedFiles(a.brief)).toContain(".openqodex.yaml");
    expect(a.brief).toContain("+  block_on_severity: critical");
    expect(changedFiles(a.brief)).not.toContain(".openqodex/config.yaml");
    const tree = checkoutOf(a)!;
    expect(readFileSync(join(tree, ".openqodex.yaml"), "utf8")).toContain("critical");
    expect(readFileSync(join(tree, ".openqodex/custom-instructions.md"), "utf8")).toContain("Developer says");
    // Named only in the target's config: never run, not even listed as untrusted.
    expect(existsSync(probe)).toBe(false);
    expect(readJson<{ scanners: { scanner: string }[] }>(join(a.dir, "scan.json")).scanners.map((s) => s.scanner)).not.toContain("custom:evil");
    expect(a.brief).not.toContain("evil");
  });

  it("runs a custom scanner the developer approved, in the temporary checkout", () => {
    const where = join(r.top, "probe-cwd");
    const bin = tempDir("oq-probe-");
    const sarif = JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "probe" } }, results: [] }] });
    write(bin, "oq-probe", `#!/bin/sh\npwd > '${where}'\nprintf '%s' '${sarif}' > "$1"\n`);
    chmodSync(join(bin, "oq-probe"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };
    writeConfig(r.dev, "scanners:\n  custom:\n    - source: https://github.com/example/probe\n      name: probe\n      run: oq-probe {report} {targets}\n      format: sarif\n      install: path\n");
    expect(run("target-probe-trust", r.dev, ["trust", "--yes"], { env }).status).toBe(0);
    const out = run("target-probe", r.dev, ["review", "--agent", "feature", "--base", "origin/main", "--only", "custom:probe", "--no-install", "--no-graph"], { env });
    expect(out.status).toBe(0);
    const findingsPath = /Write the JSON to `([^`]+agent-findings\.json)`/.exec(out.stdout)?.[1] ?? "";
    const scan = readJson<Report>(join(dirname(findingsPath), "scan.json"));
    expect(scan.scanners.find((s) => s.scanner === "custom:probe")?.status).toBe("ran");
    // The checkout is gone by now, so the path is compared as written.
    const cwd = readFileSync(where, "utf8").trim();
    expect(cwd).not.toBe(r.dev);
    expect(cwd.endsWith("/tree")).toBe(true);
    expect(cwd).toContain(`${realpathSync(toolsHome).replace(/^\/private/, "")}/checkouts/`);
  });

  it("runs no hook and no filter from the repo's config while checking out the target", () => {
    const hooks = join(r.top, "hooks");
    write(hooks, "post-checkout", `#!/bin/sh\ntouch '${join(r.top, "hook-ran")}'\n`);
    chmodSync(join(hooks, "post-checkout"), 0o755);
    git(r.dev, "config", "core.hooksPath", hooks);
    git(r.dev, "config", "filter.x.smudge", `sh -c "touch '${join(r.top, "smudge-ran")}'; cat"`);
    git(r.dev, "config", "filter.x.required", "true");
    pushBranch(r, "filtered", { ".gitattributes": "*.txt filter=x\n", "filtered.txt": "through the filter\n" });
    writeConfig(r.dev, "");
    const a = agentReview("target-hardened", r.dev, ["filtered", "--base", "origin/main"]);
    expect(checkoutOf(a)).not.toBeNull();
    expect(existsSync(join(r.top, "hook-ran"))).toBe(false);
    expect(existsSync(join(r.top, "smudge-ran"))).toBe(false);
    git(r.dev, "config", "--unset", "core.hooksPath");
  });
});

describe("review <target>: the agent flow and the temporary checkout", () => {
  let r: Repos; let a: Agent; let b: Agent;
  beforeAll(() => {
    r = repos();
    pushBranch(r, "second", { "second.txt": "another branch\n" });
    a = agentReview("target-flow-a", r.dev, ["feature", "--base", "origin/main"]);
    b = agentReview("target-flow-b", r.dev, ["second", "--base", "origin/main"]);
  }, 120_000);

  it("points the agent at the temporary checkout, forbids running the target, and names the run to finalize", () => {
    const tree = checkoutOf(a)!;
    expect(a.brief).toContain(tree);
    expect(a.brief).toMatch(/never run its tests/i);
    expect(a.brief).toContain(`review --finalize --cwd ${r.dev} --run ${a.id}`);
    expect(a.manifest.target?.repo_root).toBe(r.dev);
    expect(a.manifest.run_id).toBe(a.id);
  });
  it("keeps a young checkout of an unfinished review when another review runs", () => {
    expect(existsSync(checkoutOf(a)!)).toBe(true);
    expect(existsSync(checkoutOf(b)!)).toBe(true);
  });
  it("does not finalize from inside the temporary checkout", () => {
    findings(a, []);
    const out = run("target-finalize-inside", checkoutOf(a)!, ["review", "--finalize", "--run", a.id]);
    expect(out.status).toBe(2);
    expect(existsSync(join(a.dir, "report.json"))).toBe(false);
  });
  it("does not finalize a target run without --run", () => {
    findings(a, []);
    expect(run("target-finalize-no-run", r.dev, ["review", "--finalize"]).status).toBe(2);
    expect(existsSync(join(a.dir, "report.json"))).toBe(false);
  });
  it("keeps the checkout after a correctable finalize error", () => {
    findings(a, [{ ...finding("feature.txt", 1), severity: "wrong" }]);
    const out = run("target-finalize-invalid", r.dev, ["review", "--finalize", "--run", a.id]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("findings[0].severity");
    expect(existsSync(checkoutOf(a)!)).toBe(true);
  });
  it("removes the checkout after a successful finalize", () => {
    findings(a, []);
    expect(run("target-finalize-ok", r.dev, ["review", "--finalize", "--run", a.id]).status).toBe(0);
    expect(readJson<Report>(join(a.dir, "report.json")).kind).toBe("review");
    expect(existsSync(dirname(checkoutOf(a)!))).toBe(false);
  });
  it("refuses a checkout whose HEAD moved, and removes it", () => {
    git(checkoutOf(b)!, "-c", "core.hooksPath=/dev/null", "checkout", "-q", "--detach", "HEAD~1");
    findings(b, []);
    const out = run("target-finalize-moved", r.dev, ["review", "--finalize", "--run", b.id]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("moved");
    expect(existsSync(join(b.dir, "report.json"))).toBe(false);
    expect(existsSync(dirname(checkoutOf(b)!))).toBe(false);
  });
  it("removes a checkout older than a day on the next review", () => {
    const c = agentReview("target-flow-c", r.dev, ["feature", "--base", "origin/main"]);
    const old = new Date(Date.now() - 25 * 3600_000);
    utimesSync(join(dirname(checkoutOf(c)!), MARKER), old, old);
    expect(run("target-sweep", r.dev, ["review", "--agent", "second", "--base", "origin/main", ...FAST]).status).toBe(0);
    expect(existsSync(dirname(checkoutOf(c)!))).toBe(false);
    expect(git(r.dev, "worktree", "list")).not.toContain(checkoutOf(c)!);
  });
});

describe("review <target>: checkouts live only in the developer's openqodex home", () => {
  let r: Repos; let home: string;
  const old = new Date(Date.now() - 25 * 3600_000);
  // A folder that looks like an abandoned checkout of this repo: a marker a day old and a file.
  const decoy = (folder: string) => {
    write(folder, MARKER, JSON.stringify({ repo: r.dev, sha: "0".repeat(40), created: old.toISOString() }));
    write(folder, "keep.txt", "not openqodex's to delete\n");
    utimesSync(join(folder, MARKER), old, old);
  };
  const review = (label: string) => run(label, r.dev, ["review", "--agent", "feature", "--base", "origin/main", ...FAST], { env: { OPENQODEX_HOME: home } });
  beforeAll(() => { r = repos(); home = tempDir("oq-target-home-"); }, 120_000);

  it("ignores a folder with a forged marker in the OS temp folder", () => {
    const planted = tempDir("openqodex-target-");
    decoy(planted);
    expect(review("target-forged-tmp").status).toBe(0);
    expect(existsSync(join(planted, "keep.txt"))).toBe(true);
  });
  it("never follows a link inside the checkouts folder when it cleans up", () => {
    const victim = tempDir("oq-victim-");
    decoy(victim);
    mkdirSync(join(home, "checkouts"), { recursive: true });
    symlinkSync(victim, join(home, "checkouts", "linked"));
    expect(review("target-linked-checkout").status).toBe(0);
    expect(existsSync(join(victim, "keep.txt"))).toBe(true);
    expect(lstatSync(join(home, "checkouts", "linked")).isSymbolicLink()).toBe(true);
  });
  it("refuses to finalize a run whose checkout is outside the checkouts folder", () => {
    const a = agentReview("target-outside", r.dev, ["feature", "--base", "origin/main"], { OPENQODEX_HOME: home });
    const outside = tempDir("oq-outside-");
    decoy(outside);
    mkdirSync(join(outside, "tree"));
    writeFileSync(join(a.dir, "manifest.json"), JSON.stringify({ ...a.manifest, target: { ...a.manifest.target, checkout: join(outside, "tree") } }));
    findings(a, []);
    const out = run("target-outside-finalize", r.dev, ["review", "--finalize", "--run", a.id], { env: { OPENQODEX_HOME: home } });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("outside");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(existsSync(join(a.dir, "report.json"))).toBe(false);
  });
});

describe("a change that only deletes code", () => {
  let dir: string; let a: Agent;
  beforeAll(() => {
    dir = repos().dev;
    writeConfig(dir, "review:\n  block_on_severity: major\n");
    writeFileSync(join(dir, "app/guard.py"), GUARD.replace("    if not user.is_admin:\n        raise PermissionError(\"admins only\")\n", ""));
    a = agentReview("deletion-brief", dir, []);
  }, 120_000);

  it("lists the deletion point in the brief", () => {
    expect(a.brief).toContain("2 lines deleted after line 1 of app/guard.py");
  });
  it("keeps a finding far from the deletion outside the change", () => {
    findings(a, [finding("app/guard.py", 6)]);
    const out = run("deletion-far", dir, ["review", "--finalize"]);
    expect(out.status).toBe(0);
    const report = readJson<Report>(join(a.dir, "report.json"));
    expect(report.findings).toHaveLength(0);
    expect(report.outside_change).toHaveLength(1);
  });
  it("counts a finding on the line bordering the deletion and blocks", () => {
    findings(a, [finding("app/guard.py", 2)]);
    const out = run("deletion-border", dir, ["review", "--finalize"]);
    expect(out.status).toBe(1);
    const report = readJson<Report>(join(a.dir, "report.json"));
    expect(report.findings).toHaveLength(1);
    expect(report.verdict).toBe("blocked");
  });
});

// The CLI as a child that runs alongside another, with the same environment as `run`.
function runAsync(cwd: string, args: string[]): Promise<string> {
  const home = tempDir("oq-e2e-user-");
  const env = { ...process.env, HOME: home, OPENQODEX_HOME: toolsHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", OPENQODEX_AUTO_UPDATE: "0" };
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { err += b.toString("utf8"); });
    child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(`exit ${code}: ${err}`))));
  });
}

// True when a finding on that line counts toward the verdict, on the same run.
function counts(label: string, dir: string, a: Agent, file: string, line: number): boolean {
  findings(a, [finding(file, line)]);
  const out = run(label, dir, ["review", "--finalize"]);
  if (out.status === 2) throw new Error(out.stderr);
  return readJson<Report>(join(a.dir, "report.json")).findings.length === 1;
}

describe("deletion anchors name only lines that exist", () => {
  let dir: string; let a: Agent;
  const five = "one\ntwo\nthree\nfour\nfive\n";
  beforeAll(() => {
    dir = repos().dev;
    git(dir, "reset", "-q", "--hard", "origin/main");
    for (const f of ["start.txt", "end.txt", "emptied.txt", "gone.txt"]) write(dir, f, five);
    write(dir, "old-name.txt", "a\nb\nc\nd\ne\nf\n");
    write(dir, "crlf.txt", five.replaceAll("\n", "\r\n"));
    commitAll(dir, "Files to delete from");
    git(dir, "push", "-q", "origin", "main");
    writeConfig(dir, "review:\n  block_on_severity: major\n");
    write(dir, "start.txt", "two\nthree\nfour\nfive\n");
    write(dir, "end.txt", "one\ntwo\nthree\nfour\n");
    write(dir, "emptied.txt", "");
    git(dir, "rm", "-q", "gone.txt");
    git(dir, "mv", "old-name.txt", "new-name.txt");
    write(dir, "new-name.txt", "a\nb\nd\ne\nf\n");
    write(dir, "crlf.txt", "one\r\ntwo\r\nthree\r\nfour\r\n");
    a = agentReview("anchors-brief", dir, []);
  }, 120_000);

  it("a deletion at the start counts on line 1, and two lines away does not", () => {
    expect(counts("anchors-start", dir, a, "start.txt", 1)).toBe(true);
    expect(counts("anchors-start-far", dir, a, "start.txt", 3)).toBe(false);
  });
  it("a deletion at the end counts on the last line, never on the line past it", () => {
    expect(counts("anchors-end", dir, a, "end.txt", 4)).toBe(true);
    expect(counts("anchors-end-past", dir, a, "end.txt", 5)).toBe(false);
  });
  it("an emptied file counts only on line 1", () => {
    expect(counts("anchors-emptied", dir, a, "emptied.txt", 1)).toBe(true);
    expect(counts("anchors-emptied-2", dir, a, "emptied.txt", 2)).toBe(false);
  });
  it("a deleted file counts only on line 1", () => {
    expect(counts("anchors-gone", dir, a, "gone.txt", 1)).toBe(true);
    expect(counts("anchors-gone-2", dir, a, "gone.txt", 2)).toBe(false);
  });
  it("a renamed file anchors on its new path", () => {
    expect(counts("anchors-renamed", dir, a, "new-name.txt", 3)).toBe(true);
    expect(counts("anchors-renamed-far", dir, a, "new-name.txt", 5)).toBe(false);
  });
  it("a CRLF file with a deletion at the end counts on the last line only", () => {
    expect(counts("anchors-crlf", dir, a, "crlf.txt", 4)).toBe(true);
    expect(counts("anchors-crlf-past", dir, a, "crlf.txt", 5)).toBe(false);
  });
});

describe("review <target>: git in the checkout runs nothing", () => {
  let r: Repos;
  beforeAll(() => { r = repos(); }, 120_000);

  it("runs no fsmonitor program while the graph reads the checkout", () => {
    const marker = join(r.top, "fsmonitor-ran");
    pushBranch(r, "monitored", { "fsmon.sh": `#!/bin/sh\ntouch '${marker}'\n`, "app.py": "def f():\n    return 1\n" });
    writeConfig(r.dev, "");
    git(r.dev, "config", "core.fsmonitor", "sh ./fsmon.sh");
    const out = run("target-fsmonitor", r.dev, ["review", "--agent", "monitored", "--base", "origin/main", "--only", "hadolint", "--no-install"]);
    git(r.dev, "config", "--unset", "core.fsmonitor");
    expect(out.status, out.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
  it("runs no filter that a config include adds only for linked work trees", () => {
    const marker = join(r.top, "include-smudge-ran");
    write(r.top, "smudge.sh", `touch '${marker}'\ncat\n`);
    write(r.top, "worktree.cfg", `[filter "y"]\n\tsmudge = sh ${join(r.top, "smudge.sh")}\n\trequired = true\n`);
    git(r.dev, "config", "includeIf.gitdir:**/.git/worktrees/**.path", join(r.top, "worktree.cfg"));
    pushBranch(r, "included", { ".gitattributes": "*.txt filter=y\n", "included.txt": "through the filter\n" });
    const a = agentReview("target-include-filter", r.dev, ["included", "--base", "origin/main"]);
    git(r.dev, "config", "--unset", "includeIf.gitdir:**/.git/worktrees/**.path");
    expect(checkoutOf(a)).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
  });
  it("writes a link from the target as a plain file, so nothing outside is read through it", () => {
    const outside = join(r.top, "outside-secret.txt");
    writeFileSync(outside, "credentials outside the checkout\n");
    git(r.other, "checkout", "-q", "-B", "linked", "origin/main");
    symlinkSync(outside, join(r.other, "leak"));
    write(r.other, "linked.txt", "a change\n");
    commitAll(r.other, "A link out");
    git(r.other, "push", "-q", "-f", "origin", "HEAD:refs/heads/linked");
    git(r.other, "checkout", "-q", "main");
    const a = agentReview("target-symlink", r.dev, ["linked", "--base", "origin/main"]);
    const leak = join(checkoutOf(a)!, "leak");
    expect(lstatSync(leak).isFile()).toBe(true);
    expect(readFileSync(leak, "utf8")).toBe(outside);
  });
  it("finalize inside a checkout refuses before it reads the checkout's config", () => {
    const a = agentReview("target-inside-yaml", r.dev, ["feature", "--base", "origin/main"]);
    const tree = checkoutOf(a)!;
    rmSync(join(tree, ".openqodex/config.yaml"), { force: true });
    writeFileSync(join(tree, ".openqodex.yaml"), "review: [unclosed\n");
    const out = run("target-inside-yaml-finalize", tree, ["review", "--finalize", "--run", a.id]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("run finalize from");
  });
});

describe("review <target>: fetching touches nothing of the developer's", () => {
  let r: Repos;
  beforeAll(() => { r = repos(); }, 120_000);

  it("a pull request review creates, moves or deletes no local branch or tag", () => {
    pushBranch(r, "pr-five", { "five.txt": "pr five\n" }, "refs/pull/5/head");
    git(r.dev, "config", "--add", "remote.origin.fetch", "+refs/pull/*/head:refs/heads/pr-*");
    git(r.dev, "config", "fetch.prune", "true");
    git(r.dev, "config", "fetch.pruneTags", "true");
    git(r.dev, "update-ref", "refs/remotes/origin/gone", "HEAD");
    git(r.dev, "tag", "keep-me");
    const refs = () => git(r.dev, "for-each-ref", "--format=%(refname) %(objectname)");
    const before = refs();
    const out = run("target-refmap", r.dev, ["review", "--agent", "#5", "--base", shaOf(r.dev, "origin/main"), ...FAST]);
    expect(out.status, out.stderr).toBe(0);
    expect(refs()).toBe(before);
  });
  it("two pull request reviews started together each record their own head", async () => {
    const eight = pushBranch(r, "pr-eight", { "eight.txt": "eight\n" }, "refs/pull/8/head");
    const nine = pushBranch(r, "pr-nine", { "nine.txt": "nine\n" }, "refs/pull/9/head");
    const base = shaOf(r.dev, "origin/main");
    const [x, y] = await Promise.all(["#8", "#9"].map((spec) => runAsync(r.dev, ["review", "--agent", spec, "--base", base, ...FAST])));
    const head = (stdout: string) => /- Target: \S+ at ([0-9a-f]{12})/.exec(stdout)?.[1];
    expect(head(x)).toBe(eight.slice(0, 12));
    expect(head(y)).toBe(nine.slice(0, 12));
  });
  it("fetches a remote base that this clone has never seen", () => {
    pushBranch(r, "release-next", { "next.txt": "next\n" });
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "origin/release-next"], { cwd: r.dev }).status).not.toBe(0);
    const out = run("target-new-base", r.dev, ["review", "--agent", "feature", "--base", "origin/release-next", ...FAST]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain("base origin/release-next (from --base)");
  });
});

describe("review <target> in a partial clone", () => {
  it("fails in one line rather than fetch a missing file during checkout", () => {
    const r = repos();
    git(r.remote, "config", "uploadpack.allowFilter", "true");
    git(r.remote, "config", "uploadpack.allowAnySHA1InWant", "true");
    pushBranch(r, "x", { "big.txt": "only on x\n" });
    git(r.other, "fetch", "-q", "origin");
    git(r.other, "checkout", "-q", "-B", "y", "origin/x");
    write(r.other, "y.txt", "on y\n");
    commitAll(r.other, "y");
    git(r.other, "push", "-q", "origin", "HEAD:refs/heads/y");
    git(r.other, "checkout", "-q", "main");
    const partial = join(r.top, "partial");
    git(r.top, "clone", "-q", "--filter=blob:none", `file://${r.remote}`, partial);
    git(partial, "cat-file", "-p", "origin/y:y.txt");
    const missing = () => spawnSync("git", ["cat-file", "-e", "origin/x:big.txt"], { cwd: partial, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }).status !== 0;
    expect(missing()).toBe(true);
    const out = run("target-partial", partial, ["review", "--agent", "origin/y", "--base", "origin/x", "--offline", ...FAST]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("not downloaded");
    expect(missing()).toBe(true);
  });
});

describe("a changed scanner settings file", () => {
  // Each case starts from a fresh clone, so earlier edits never leak into the next.
  type Scan = { status: number | null; report: Report };
  const scan = (label: string, dir: string): Scan => {
    const out = run(label, dir, ["scan", "--only", "gitleaks,ruff", "--no-install", "--format", "json"]);
    if (out.status === 2) throw new Error(out.stderr);
    return { status: out.status, report: JSON.parse(out.stdout) as Scan["report"] };
  };
  const settingsTokens = (s: Scan) =>
    s.report.findings.filter((f) => f.source?.endsWith(":settings-file")).map((f) => `${f.source} ${f.file_path}`);
  const fresh = () => {
    const dir = repos().dev;
    writeConfig(dir, "review:\n  block_on_severity: major\n");
    return dir;
  };

  it("a pyproject.toml version bump and a gitleaks config gitleaks never reads raise nothing and do not block", () => {
    const dir = fresh();
    write(dir, "pyproject.toml", "[project]\nname = \"app\"\nversion = \"1.0.0\"\n");
    commitAll(dir, "Project file");
    git(dir, "push", "-q", "origin", "HEAD:main", "-f");
    write(dir, "pyproject.toml", "[project]\nname = \"app\"\nversion = \"1.0.1\"\n");
    write(dir, "sub/.gitleaks.toml", "[allowlist]\npaths = [\".*\"]\n");
    const s = scan("settings-not-honoured", dir);
    expect(s.status).toBe(0);
    expect(s.report.verdict).toBe("passed");
    expect(settingsTokens(s)).toEqual([]);
  });
  it("a root .gitleaksignore in a scan counts as a minor finding, which blocks only at block_on_severity minor", () => {
    const dir = fresh();
    write(dir, ".gitleaksignore", "app/keys.py:stripe-access-token:1\n");
    const s = scan("settings-scan-minor", dir);
    expect(s.status).toBe(0);
    expect(s.report.findings.map((f) => `${f.source} ${f.file_path}:${f.line_number} ${f.severity}`)).toEqual(["gitleaks:settings-file .gitleaksignore:1 minor"]);
    expect(s.report).not.toHaveProperty("settings_changes");
    writeConfig(dir, "review:\n  block_on_severity: minor\n");
    const blocked = scan("settings-scan-block-minor", dir);
    expect(blocked.status).toBe(1);
    expect(blocked.report.verdict).toBe("blocked");
  });
  it("a change to the [tool.ruff] table of pyproject.toml raises the ruff note", () => {
    const dir = fresh();
    write(dir, "pyproject.toml", "[project]\nname = \"app\"\n\n[tool.ruff]\nline-length = 100\n");
    commitAll(dir, "Ruff settings");
    git(dir, "push", "-q", "origin", "HEAD:main", "-f");
    write(dir, "pyproject.toml", "[project]\nname = \"app\"\n\n[tool.ruff]\nline-length = 100\nlint.ignore = [\"ALL\"]\n");
    expect(settingsTokens(scan("settings-ruff-table", dir))).toEqual(["ruff:settings-file pyproject.toml"]);
  });
  it("ruff settings written in a form other than a [tool.ruff] header still raise the ruff note", () => {
    for (const [label, body] of [
      ["quoted", '[project]\nname = "app"\n\n[tool."ruff".lint]\nignore = ["ALL"]\n'],
      ["dotted", '[project]\nname = "app"\n\n[tool]\nruff.lint.ignore = ["ALL"]\n'],
      ["inline", '[project]\nname = "app"\n\n[tool]\nruff = { line-length = 320 }\n'],
    ] as const) {
      const dir = fresh();
      write(dir, "pyproject.toml", '[project]\nname = "app"\n');
      commitAll(dir, "Project file");
      git(dir, "push", "-q", "origin", "HEAD:main", "-f");
      write(dir, "pyproject.toml", body);
      expect(settingsTokens(scan(`settings-ruff-${label}`, dir)), label).toEqual(["ruff:settings-file pyproject.toml"]);
    }
  });
  // ruff and SQLFluff both read pyproject.toml, so a file too large to read
  // may hide either one's findings: both notes are raised.
  it("a pyproject.toml too large to read raises the ruff and SQLFluff notes rather than none", () => {
    const dir = fresh();
    write(dir, "pyproject.toml", '[project]\nname = "app"\n');
    commitAll(dir, "Project file");
    git(dir, "push", "-q", "origin", "HEAD:main", "-f");
    write(dir, "pyproject.toml", `[project]\nname = "app"\n# ${"x".repeat(1024 * 1024 + 10)}\n`);
    expect(settingsTokens(scan("settings-ruff-unreadable", dir))).toEqual(["sqlfluff:settings-file pyproject.toml", "ruff:settings-file pyproject.toml"]);
  });
  it("a root .gitleaksignore added with a secret is a candidate in the agent's brief", () => {
    const dir = fresh();
    write(dir, "app/keys.py", `KEY = "sk_live_${randomBytes(12).toString("hex")}"\n`);
    write(dir, ".gitleaksignore", "app/keys.py:stripe-access-token:1\n");
    const out = run("settings-brief", dir, ["review", "--agent", "--only", "gitleaks", "--no-install", "--no-graph"]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/\[gitleaks:settings-file\] \.gitleaksignore:1/);
  });
});