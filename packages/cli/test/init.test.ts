// `openqodex init`, run as the real built CLI in temp homes and temp repos.
//
// Ways it could fail, written before the code:
//  1. A user-scope install changes the repo's `git status`.
//  2. A second run rewrites a file or adds a second hook entry.
//  3. Merging into an existing settings.json drops other keys or hooks, or
//     touches a developer's own handler that merely mentions openqodex.
//  4. A settings file that does not parse, or cannot be read, is replaced.
//  5. The hook command breaks when the home path holds a space or `$&`.
//  6. `--project` uses the absolute launcher path in files a team commits.
//  7. Uninstall removes what the developer edited or owned: an edited skill
//     or section, an exclude line that was there before, a line another
//     worktree still needs, unrelated files under runtime/, a launcher still
//     called by a hook it could not remove.
//  8. Init overwrites a launcher it did not write.
//  9. A symlinked dotfile becomes a regular file; a symlink inside the repo
//     sends a write outside it.
// 10. A merge widens a private settings file's permissions.
// 11. `--dry-run`, or no terminal without --yes, writes something.
// 12. Init fails, or hides it, when the scanner installs cannot start.
// 13. The pre-push hook is not added on --yes, is added on --hook none, or a
//     second init asks the hook question again.
// 14. Uninstall leaves the global instruction section behind, or removes the
//     developer's own text around it.
// 15. --project leaves the section out of the repo's CLAUDE.md or AGENTS.md.
// 16. With CLAUDE_CONFIG_DIR or CODEX_HOME set, init reports success but puts
//     the skill, instructions or push hook in a folder the agent does not
//     read, or does not find an agent known only by that folder.
// 17. A skill `npx skills add` copied over the stub (any version's shipped
//     text) is kept as the developer's, so it never updates; or a copy the
//     developer edited is replaced.
// 18. Init asks more than once in a terminal (the hook, the team section,
//     then the files), the plan does not say which files are the
//     developer's and which the team's, an agent's shell (no terminal) can
//     never install without --yes, or a shell with no terminal and no agent
//     writes something or stops without the plan and the flags to choose with.
// 20. The global instruction files of every repo get the whole review
//     procedure instead of one line; an install made by an earlier version
//     keeps its long section; or init ends without saying what it wrote for
//     the developer (with the undo) and for the team, and that --project
//     keeps everything inside the repo.
// 28. A write compares places by their spelling while the filesystem acts on
//     identity: a repo with no letter in its name, a name in the other
//     Unicode normalisation (on a volume that keeps case or normalisation,
//     the other spelling is another folder, never the repository), a common
//     git folder that holds the work tree
//     exempting its links, OpenQodex's own install.json or runtime folder
//     as a link that sends a write or a delete outside, a terminal run that
//     changes the record without asking, or a skill holding the placeholder
//     text taken for a shipped copy.
// 27. A write decides from the path's spelling, not where it really lands:
//     `.` and `..` folded before the links on the way are followed, a work
//     tree name that starts with two dots taken for outside the repository,
//     the repository spelled in another case on a volume that folds case (on
//     one that keeps case, another folder, never the repository), a
//     sibling folder sharing a root's name prefix taken for inside it, or a
//     path that lands outside every folder init may write.
// 26. A file init writes outside the repository's rules follows a link the
//     repository holds: an agent folder set inside the repository
//     (CLAUDE_CONFIG_DIR) with a committed link, a link inside the repository
//     on the way to a folder named from outside it, or a link swapped in
//     between the plan and the write.
// 25. init says --project keeps everything inside the repository, while the
//     scanners, the record and any launcher stay under ~/.openqodex.
// 24. init says every push from the repo is checked when it wrote no hook:
//     husky runs the repo's hooks, or a pre-push hook it did not write is in
//     the way, and the developer is not told what to add.
// 23. --yes overrides a choice this repo recorded before (--no-repo, --hook
//     none), or it does not take the defaults in a repo that recorded none.
// 22. The scanner downloads init starts miss a file type that only an
//     untracked file has, or download a scanner the config switches off.
// 21. A command init prints for the developer to run next (the review, the
//     undo) names a bare `openqodex`, which an npx install never puts on PATH,
//     so pasting it exits 127.
// 19. With no agent found, init stops with a flag list although a terminal
//     could ask which agents to install into; or, with no terminal, it asks
//     or installs instead of exiting 2 with that list.
// 29. The scanners init downloads ignore the repo's config (scanners.disable,
//     review.paths.exclude), take a React Native app's CocoaPods Gemfile for
//     a Rails app, give no reason line per scanner, or --dry-run downloads.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BIN, cli, env, git, inTerminal, promptsAsked, sandbox, snapshot, status, tree, type Sandbox } from "./init-helpers.js";
import { gitDirs } from "../src/agents/git.js";
import { Guard } from "../src/agents/guarded-fs.js";
import { isShippedSkill } from "../src/agents/targets.js";
import { adoptTempDir, removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

// What the volume does with another spelling of an existing folder, by the
// evidence the write check itself uses: whether that spelling reaches the
// same folder by identity (device and inode). macOS volumes fold case and
// Unicode normalisation by default; Linux ext4 and a case-sensitive APFS
// image keep them, and there the other spelling is another folder.
function sameFolder(a: string, b: string): boolean {
  const x = lstatSync(a, { throwIfNoEntry: false });
  const y = lstatSync(b, { throwIfNoEntry: false });
  return x !== undefined && y !== undefined && x.dev === y.dev && x.ino === y.ino;
}

// After an init whose agent folder was another spelling of the repository:
// on a folding volume that is the repository, and its link to `outside` is
// refused (exit 2); on one that keeps the spelling it is a folder of its own
// outside the repository, the folder Claude Code reads there, and init
// writes the skill into it (exit 0). Either way nothing lands through the
// repository's link, which is left as it was.
function expectSpelling(r: ReturnType<typeof cli>, folds: boolean, agentFolder: string, link: string, outside: string): void {
  if (folds) {
    expect(r.status, r.stderr).toBe(2);
  } else {
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(agentFolder, "skills/openqodex/SKILL.md"))).toBe(true);
  }
  expect(readdirSync(outside)).toEqual([]);
  expect(readlinkSync(link)).toBe(outside);
}

const version = (JSON.parse(readFileSync(join(BIN, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const isRoot = process.getuid?.() === 0;

type Settings = { hooks: { PreToolUse: { matcher?: string; hooks: { command: string; if?: string }[] }[] } };

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function ourCommands(path: string): string[] {
  return readJson<Settings>(path)
    .hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command))
    .filter((c) => c.endsWith(" hook check"));
}

// What a first init or scan adds to git status: the folder's .gitignore and
// the two team files, meant to be committed.
const REPO_FOLDER_STATUS = "?? .openqodex/.gitignore\n?? .openqodex/config.yaml\n?? .openqodex/custom-instructions.md\n";

// A command as the developer would paste it into a shell in the repo.
function paste(s: Sandbox, command: string): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } {
  return spawnSync("sh", ["-c", command], { cwd: s.repo, env: env(s), encoding: "utf8" });
}

describe("init, user scope, all agents", () => {
  // One install that the cases below only read, until the last one removes it.
  let s: Sandbox;
  let statusBefore: string;
  let first: ReturnType<typeof cli>;

  beforeAll(() => {
    expect(existsSync(BIN), "build the CLI first (pnpm build)").toBe(true);
    s = sandbox();
    statusBefore = status(s);
    first = cli(s, ["init", "--yes", "--agent", "all"]);
    expect(first.status, first.stderr).toBe(0);
  });

  it("writes hook commands that run through sh from a home path with a space", () => {
    for (const f of [join(s.home, ".claude/settings.json"), join(s.home, ".codex/hooks.json")]) {
      const [command] = ourCommands(f);
      expect(command).not.toContain("npx");
      const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: s.repo });
      const r = spawnSync("sh", ["-c", command], { input, encoding: "utf8", env: env(s), cwd: s.repo });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("OpenQodex has not reviewed this change");
    }
  });

  it("20. writes one line into each agent's global instruction file", () => {
    for (const file of [join(s.home, ".claude/CLAUDE.md"), join(s.home, ".codex/AGENTS.md")]) {
      expect(sectionOf(file)).toEqual(["Before any push, review the change with the openqodex skill."]);
    }
  });

  it("20. ends by naming what it wrote for you, with the undo, and for the team, and init --project", () => {
    const end = first.stdout.slice(first.stdout.lastIndexOf("is installed for"));
    const mine = end.indexOf("Written for you");
    const team = end.indexOf("Written for the team");
    expect(mine).toBeGreaterThan(-1);
    expect(team).toBeGreaterThan(mine);
    expect(end.slice(mine, team)).toContain("~/.claude/skills/openqodex/SKILL.md");
    // The home path holds a space, so the launcher is written in single quotes.
    expect(end.slice(mine, team)).toContain(`'${join(s.oqHome, "bin/openqodex")}' init --uninstall`);
    expect(end.slice(team)).toContain(".openqodex/config.yaml");
    expect(end.slice(team)).toContain("CLAUDE.md");
    expect(end).toContain("init --project");
    // 25. --project moves the agent files only: the scanners and init's own
    // record stay on this machine, and the line must not say otherwise.
    expect(end).not.toMatch(/keep everything inside/i);
    expect(end).toMatch(/init --project[^\n]*~\/\.openqodex/);
  });

  it("13. --yes adds the pre-push hook; a second run without --yes asks nothing and changes nothing", () => {
    expect(readFileSync(join(s.repo, ".git/hooks/pre-push"), "utf8")).toContain(join(s.oqHome, "bin/openqodex"));
    expect(first.stdout).toContain("Every push from this repo is now checked for a review");
    const before = snapshot(s);
    // No terminal and no --yes: a run that had to ask or write would exit 2.
    const second = cli(s, ["init", "--agent", "all"]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("Nothing to change");
    expect(second.stdout).not.toContain("pre-push hook: not asked");
    expect(snapshot(s)).toEqual(before);
  });

  it("21. the next review init prints runs from a shell with no openqodex on PATH", () => {
    const next = /^Next: .* or run (.+)$/m.exec(first.stdout)?.[1];
    expect(next, first.stdout).toBeDefined();
    // In a repository of its own: the review writes its folder there, which
    // the uninstall below would leave in this one.
    const other = { ...s, repo: join(s.root, "other repo") };
    mkdirSync(other.repo);
    git(other.repo, "init", "-q", "-b", "main");
    expect(paste(other, "command -v openqodex").status).not.toBe(0);
    // What fails is the program name. The flags keep the test from
    // downloading scanners.
    const review = paste(other, `${next!} --no-install --offline`);
    expect(review.status, review.stderr).not.toBe(127);
    expect(review.stderr).not.toMatch(/not found/);
  });

  // Last: it removes the install the cases above read.
  it("21. the undo init prints runs as pasted, and restores the starting state", () => {
    const undo = /To undo: (.+)$/m.exec(first.stdout)?.[1];
    expect(undo, first.stdout).toBeDefined();
    // --yes stands in for the answer in a terminal.
    const r = paste(s, `${undo!} --yes`);
    expect(r.status, r.stderr).toBe(0);
    expect(status(s)).toBe(statusBefore);
    expect(readFileSync(join(s.repo, ".git/info/exclude"), "utf8")).not.toContain("openqodex");
    expect(Object.keys(snapshot(s)).filter((p) => p.startsWith("home dir"))).toEqual([]);
  });
});

describe("init, settings files", () => {
  it("keeps other keys and the developer's own handlers, even one naming openqodex, and uninstall puts the file back byte for byte", () => {
    const s = sandbox();
    const settings = join(s.home, ".claude/settings.json");
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    const original = `${JSON.stringify(
      {
        model: "x",
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo openqodex hook check" }] }],
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
        },
      },
      null,
      4,
    )}\n`;
    writeFileSync(settings, original);

    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    const merged = readJson<Settings & { model: string }>(settings);
    expect(merged.model).toBe("x");
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(merged.hooks.PreToolUse[0].hooks[0].command).toBe("echo openqodex hook check");
    expect(merged.hooks.PreToolUse[1].hooks[0].if).toBe("Bash(git push*)");

    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).stdout).toContain("Nothing to change");
    expect(cli(s, ["init", "--uninstall", "--yes", "--agent", "claude-code"]).status).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(readdirSync(join(s.home, ".claude")).filter((n) => n.includes(".bak"))).toEqual([]);
  });

  it("leaves a settings file that does not parse byte-identical, installs the other agent, exits 2", () => {
    const s = sandbox();
    const settings = join(s.home, ".claude/settings.json");
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    writeFileSync(settings, "{ not json,\n");
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--agent", "codex"]);
    expect(r.status).toBe(2);
    expect(readFileSync(settings, "utf8")).toBe("{ not json,\n");
    expect(ourCommands(join(s.home, ".codex/hooks.json"))).toHaveLength(1);
  });

  it.skipIf(isRoot)("leaves an unreadable settings file in place and exits 2", () => {
    const s = sandbox();
    const settings = join(s.home, ".claude/settings.json");
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    writeFileSync(settings, '{"model":"x"}\n');
    chmodSync(settings, 0o000);
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--agent", "codex"]);
    chmodSync(settings, 0o600);
    expect(r.status).toBe(2);
    expect(readFileSync(settings, "utf8")).toBe('{"model":"x"}\n');
    expect(existsSync(join(s.home, ".codex/hooks.json"))).toBe(true);
  });

  it("keeps a private settings file private, and its backup too", () => {
    const s = sandbox();
    const settings = join(s.home, ".claude/settings.json");
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    writeFileSync(settings, '{"model":"x"}\n', { mode: 0o600 });
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    expect(statSync(settings).mode & 0o777).toBe(0o600);
    const backups = readdirSync(join(s.home, ".claude")).filter((n) => n.includes(".bak"));
    expect(backups).toHaveLength(1);
    expect(statSync(join(s.home, ".claude", backups[0])).mode & 0o777).toBe(0o600);
  });

  it("writes through a symlinked settings file and leaves the link a link", () => {
    const s = sandbox();
    // The developer's dotfiles, in the home folder: a folder init may write.
    const dotfiles = join(s.home, "dotfiles");
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, "settings.json"), '{"model":"x"}\n');
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    symlinkSync(join(dotfiles, "settings.json"), join(s.home, ".claude/settings.json"));
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    expect(lstatSync(join(s.home, ".claude/settings.json")).isSymbolicLink()).toBe(true);
    expect(ourCommands(join(dotfiles, "settings.json"))).toHaveLength(1);
  });

  it("puts a home path holding $& into the hook command literally", () => {
    const s = sandbox({}, "oq $& test ");
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    const [command] = ourCommands(join(s.home, ".claude/settings.json"));
    expect(command).toContain(join(s.oqHome, "bin/openqodex"));
  });
});

describe("init, files the developer owns or edited", () => {
  it("keeps an edited skill on a second run and on uninstall, and says so", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    const skill = join(s.home, ".claude/skills/openqodex/SKILL.md");
    const edited = `${readFileSync(skill, "utf8")}\nCompany rule: also check the changelog.\n`;
    writeFileSync(skill, edited);
    const again = cli(s, ["init", "--yes", "--agent", "claude-code"]);
    expect(readFileSync(skill, "utf8")).toBe(edited);
    expect(again.stdout).toContain("edited");
    const u = cli(s, ["init", "--uninstall", "--yes"]);
    expect(readFileSync(skill, "utf8")).toBe(edited);
    expect(u.stdout).toContain("edited");
  });

  it("17. replaces a copy of the shipped skill (npx skills add) with the stub and records it", () => {
    const shipped = readFileSync(join(BIN, "..", "..", "skills/openqodex/SKILL.md"), "utf8");
    const s = sandbox();
    const skill = join(s.home, ".claude/skills/openqodex/SKILL.md");
    mkdirSync(join(skill, ".."), { recursive: true });
    writeFileSync(skill, shipped);
    const r = cli(s, ["init", "--yes", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    const now = readFileSync(skill, "utf8");
    expect(now).toContain("guide skill");
    expect(now).not.toContain("openqodex@");
    const record = readJson<{ files: { path: string; sha256: string }[] }>(join(s.oqHome, "install.json"));
    const sha = createHash("sha256").update(now).digest("hex");
    expect(record.files).toContainEqual(expect.objectContaining({ path: skill, sha256: sha }));
  });

  // Which skill texts init takes for a shipped copy it may replace, and which
  // for the developer's, kept. The run above proves init asks this question.
  describe("17 and 28. a shipped copy or the developer's edit", () => {
    const shipped = readFileSync(join(BIN, "..", "..", "skills/openqodex/SKILL.md"), "utf8");
    const runner = "'/home/dev/.openqodex/bin/openqodex'";
    const pins = /npx -y openqodex@\d+\.\d+\.\d+/g;
    const paragraph = /^When the file `~\/\.openqodex\/bin\/openqodex` exists[^\n]*/m;
    it.each([
      ["the file as this version shipped it", shipped, true],
      ["the file as an earlier version shipped it", shipped.replace(/openqodex@\d+\.\d+\.\d+/g, "openqodex@0.7.1"), true],
      ["the full skill an earlier user-scope init wrote, the launcher in place of npx", shipped.replace(/^When the file `~\/\.openqodex\/bin\/openqodex` exists[^\n]*\n\n/m, "").replace(pins, runner), true],
      ["a shipped copy the developer added a line to", `${shipped}\nCompany rule: also check the changelog.\n`, false],
      ["a shipped copy whose launcher paragraph the developer edited", shipped.replace(paragraph, (p) => `${p} Company rule: use the launcher in CI too.`), false],
      ["a skill that holds a placeholder for the runner literally", shipped.replace(pins, "<runner>"), false],
      ["a skill that spells out the key's own runner placeholder", shipped.replace(pins, "\u0000runner\u0000"), false],
    ])("%s: shipped is %s", (_name, text, isShipped) => {
      expect(isShippedSkill(text, runner)).toBe(isShipped);
    });
  });

  it("does not overwrite or remove a foreign rule file with the same name", () => {
    const s = sandbox();
    const rule = join(s.home, "Documents/Cline/Rules/openqodex.md");
    mkdirSync(join(rule, ".."), { recursive: true });
    writeFileSync(rule, "my own rule\n");
    expect(cli(s, ["init", "--yes", "--agent", "cline"]).status).toBe(0);
    expect(readFileSync(rule, "utf8")).toBe("my own rule\n");
    const un = cli(s, ["init", "--uninstall", "--yes"]);
    expect(un.status, un.stderr).toBe(0);
    expect(readFileSync(rule, "utf8")).toBe("my own rule\n");
  });

  it("keeps an exclude line that was there before init", () => {
    const s = sandbox();
    const exclude = join(s.repo, ".git/info/exclude");
    writeFileSync(exclude, "/.cursor/rules/openqodex.mdc\n");
    expect(cli(s, ["init", "--yes", "--agent", "cursor"]).status).toBe(0);
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(readFileSync(exclude, "utf8")).toBe("/.cursor/rules/openqodex.mdc\n");
  });

  it("keeps the exclude line while another worktree's rule still needs it", () => {
    const s = sandbox();
    const other = join(s.root, "other worktree");
    git(s.repo, "worktree", "add", "-q", "-b", "other", other);
    // --no-repo: only the rule's exclude line is under test here.
    expect(cli(s, ["init", "--yes", "--no-repo", "--agent", "cursor"]).status).toBe(0);
    expect(cli(s, ["init", "--yes", "--no-repo", "--agent", "cursor"], { cwd: other }).status).toBe(0);
    expect(cli(s, ["init", "--uninstall", "--yes", "--agent", "cursor"]).status).toBe(0);
    expect(git(other, "status", "--porcelain", "--untracked-files=all")).toBe(REPO_FOLDER_STATUS);
  });

  it("refuses a launcher it did not write, and writes no hook that would call it", () => {
    const s = sandbox();
    mkdirSync(join(s.oqHome, "bin"), { recursive: true });
    writeFileSync(join(s.oqHome, "bin/openqodex"), "#!/bin/sh\necho mine\n");
    const r = cli(s, ["init", "--yes", "--agent", "claude-code"]);
    expect(r.status).toBe(2);
    expect(readFileSync(join(s.oqHome, "bin/openqodex"), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(existsSync(join(s.home, ".claude/settings.json"))).toBe(false);
  });

  it("uninstall leaves files it did not write under runtime/", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    writeFileSync(join(s.oqHome, "runtime", "notes.txt"), "mine\n");
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(readFileSync(join(s.oqHome, "runtime", "notes.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(s.oqHome, "runtime", version))).toBe(false);
  });

  it("keeps the launcher while a settings file it cannot parse may still call it", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    const settings = join(s.home, ".claude/settings.json");
    writeFileSync(settings, `${readFileSync(settings, "utf8")},broken`);
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(2);
    const launcher = join(s.oqHome, "bin/openqodex");
    expect(spawnSync(launcher, ["--version"], { encoding: "utf8", env: env(s) }).stdout.trim()).toBe(version);
  });
});

describe("init, project scope", () => {
  it("uses the pinned npx command, and a teammate without a record can uninstall what is unchanged", () => {
    const s = sandbox({ "AGENTS.md": "# Agents\n\nBe nice.\n" });
    expect(cli(s, ["init", "--yes", "--project", "--agent", "all"]).status).toBe(0);
    expect(ourCommands(join(s.repo, ".claude/settings.json"))).toEqual([`npx -y openqodex@${version} hook check`]);
    expect(existsSync(join(s.repo, ".clinerules/openqodex.md"))).toBe(true);
    git(s.repo, "add", "-A");
    git(s.repo, "commit", "-q", "-m", "openqodex");

    // The teammate: same repo, a fresh home with no installation record.
    const teammate = { ...s, home: join(s.root, "teammate"), oqHome: join(s.root, "teammate", ".openqodex") };
    mkdirSync(teammate.home);
    expect(cli(teammate, ["init", "--uninstall", "--yes", "--project"]).status).toBe(0);
    expect(readFileSync(join(s.repo, "AGENTS.md"), "utf8")).toBe("# Agents\n\nBe nice.\n");
    expect(git(s.repo, "ls-files", "--deleted")).not.toBe("");
    expect(existsSync(join(s.repo, ".claude/settings.json"))).toBe(false);
  });

  it("keeps an AGENTS.md section the developer edited", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--project", "--agent", "codex"]).status).toBe(0);
    const agents = join(s.repo, "AGENTS.md");
    const edited = readFileSync(agents, "utf8").replace("## Review with OpenQodex", "## Review with OpenQodex, our way");
    writeFileSync(agents, edited);
    const again = cli(s, ["init", "--yes", "--project", "--agent", "codex"]);
    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(agents, "utf8")).toBe(edited);
    const un = cli(s, ["init", "--uninstall", "--yes", "--project"]);
    expect(un.status, un.stderr).toBe(0);
    expect(readFileSync(agents, "utf8")).toBe(edited);
  });
});

describe("init, writes nothing when it should not", () => {
  it("18. without a terminal, an agent or --yes, exits 2, writes nothing, and prints the plan and the flags", () => {
    const s = sandbox();
    const before = snapshot(s);
    const r = cli(s, ["init", "--agent", "claude-code"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("install plan");
    expect(r.stdout).toContain(join(s.home, ".claude/skills/openqodex/SKILL.md"));
    for (const flag of ["--yes", "--hook none", "--no-repo", "--project"]) expect(r.stderr).toContain(flag);
    expect(snapshot(s)).toEqual(before);
  });
});

// The section of `path` between the markers, markers left out.
const START = "<!-- openqodex:start -->";
function sectionOf(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return text.slice(text.indexOf(START) + START.length, text.indexOf("<!-- openqodex:end -->")).trim().split("\n");
}

// The global section an earlier version wrote, as it recorded it.
const OLD_SECTION = [
  START,
  "## Review with OpenQodex",
  '- When a feature or fix is done, and before any push, review it with the openqodex skill: "review my change with openqodex".',
  "- OpenQodex starts its own reviewer process for the review: the agent that wrote the code does not judge its own work.",
  "- Do not push on a blocked verdict unless the developer says so after seeing the findings.",
  "- The report is in `.openqodex/reviews/`.",
  "<!-- openqodex:end -->",
].join("\n");

describe("20. the global section and what init says it wrote", () => {
  it("replaces the long section an earlier version wrote and recorded", () => {
    const s = sandbox();
    const claudeMd = join(s.home, ".claude/CLAUDE.md");
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    mkdirSync(s.oqHome, { recursive: true });
    writeFileSync(claudeMd, `# Mine\n\n${OLD_SECTION}\n`);
    writeFileSync(join(s.oqHome, "install.json"), JSON.stringify({ version: 1, sections: [{ path: claudeMd, text: OLD_SECTION, createdFile: false }] }));
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    expect(sectionOf(claudeMd)).toHaveLength(1);
    expect(readFileSync(claudeMd, "utf8").startsWith("# Mine\n")).toBe(true);
  });
});

describe("19. init with no agent found", () => {
  // Agent detection also sees a real system Cursor installation.
  it.skipIf(existsSync("/Applications/Cursor.app"))("in a terminal, offers the four agents and installs into the one chosen", () => {
    const s = sandbox();
    // Space ticks the first agent, Claude Code; clack redraws that line only.
    const r = inTerminal(s, ["init"], [["Space: select", " "], ["◼ Claude Code", "\r"], ["Write these files?", "\r"]]);
    expect(r.stdout).toContain("No coding agent found on this machine");
    expect(r.status, r.stdout).toBe(0);
    for (const name of ["Claude Code", "Cursor", "Codex CLI", "Cline"]) expect(r.stdout).toContain(name);
    // No other question than the chooser and the one confirmation.
    expect(promptsAsked(r.stdout).filter((p) => p !== "Write these files?" && !p.startsWith("No coding agent found"))).toEqual([]);
    expect(existsSync(join(s.home, ".claude/skills/openqodex/SKILL.md"))).toBe(true);
    expect(existsSync(join(s.home, ".agents/skills/openqodex/SKILL.md"))).toBe(false);
  });

  it.skipIf(existsSync("/Applications/Cursor.app"))("without a terminal, exits 2 with the --agent list and writes nothing", () => {
    const s = sandbox();
    const before = snapshot(s);
    const r = cli(s, ["init", "--yes"]);
    expect(r.status).toBe(2);
    for (const agent of ["claude-code", "cursor", "codex", "cline", "all"]) expect(r.stderr).toContain(`--agent ${agent}`);
    expect(snapshot(s)).toEqual(before);
  });
});

describe("18. init asks once", () => {
  it("in a terminal, asks only 'Write these files?', and writes the hook and the team section by default", () => {
    const s = sandbox();
    const r = inTerminal(s, ["init", "--agent", "claude-code"], [["Write these files?", "\r"]]);
    expect(r.status, r.stdout).toBe(0);
    expect(promptsAsked(r.stdout)).toEqual(["Write these files?"]);
    expect(existsSync(join(s.repo, ".git/hooks/pre-push"))).toBe(true);
    expect(readFileSync(join(s.repo, "CLAUDE.md"), "utf8")).toContain(SECTION_START);
  });

  it("11 and 18. --dry-run for every agent writes nothing, puts every file under 'For you' or 'For the team' and names the two opt-outs", () => {
    const s = sandbox();
    const before = snapshot(s);
    const r = cli(s, ["init", "--dry-run", "--agent", "all"]);
    expect(r.status, r.stderr).toBe(0);
    expect(snapshot(s)).toEqual(before);
    const mine = r.stdout.indexOf("For you");
    const team = r.stdout.indexOf("For the team");
    expect(mine).toBeGreaterThan(-1);
    expect(team).toBeGreaterThan(mine);
    const at = (path: string): number => r.stdout.indexOf(path);
    expect(at(join(s.home, ".claude/skills/openqodex/SKILL.md"))).toBeGreaterThan(mine);
    expect(at(join(s.home, ".claude/skills/openqodex/SKILL.md"))).toBeLessThan(team);
    expect(at(join(s.repo, ".git/hooks/pre-push"))).toBeLessThan(team);
    expect(at(join(s.repo, "CLAUDE.md"))).toBeGreaterThan(team);
    expect(at(join(s.repo, ".openqodex/config.yaml"))).toBeGreaterThan(team);
    expect(r.stdout).toContain("--hook none");
    expect(r.stdout).toContain("--no-repo");
  });

  it("inside a known agent with no terminal, takes the defaults and writes what --yes writes", () => {
    const withYes = sandbox();
    expect(cli(withYes, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    // Git's object names hold each sandbox's commit time; every other path is compared.
    const files = (s: Sandbox): string[] => Object.keys(snapshot(s)).filter((p) => !p.includes("/.git/objects/")).sort();
    for (const marker of [{ CLAUDECODE: "1" }, { CODEX_THREAD_ID: "019a0000-0000-0000-0000-000000000000" }, { CURSOR_AGENT: "1" }]) {
      const s = sandbox();
      const r = cli(s, ["init", "--agent", "claude-code"], { env: marker });
      expect(r.status, r.stderr).toBe(0);
      expect(files(s)).toEqual(files(withYes));
    }
  });
});

// A live lock on every tool makes the background install skip it, so a test
// that tracks files never starts a download.
function lockTools(s: Sandbox): void {
  const tools = Object.keys(readJson<{ tools: Record<string, unknown> }>(join(BIN, "..", "..", "toolchain.json")).tools);
  for (const tool of tools) {
    mkdirSync(join(s.oqHome, "tools", tool), { recursive: true });
    writeFileSync(join(s.oqHome, "tools", tool, ".lock"), `${process.pid} test\n`);
  }
}

describe("init, after writing", () => {
  it("downloads what the repo's files and config call for, says why, and --dry-run downloads nothing (29)", () => {
    const s = sandbox({
      "package.json": JSON.stringify({ dependencies: { expo: "~52.0.0", react: "18.3.1", "react-native": "0.76.0" } }),
      "app/index.tsx": "export default function Home() { return null; }\n",
      Gemfile: "source 'https://rubygems.org'\ngem 'cocoapods', '>= 1.13'\n",
      "deploy.sh": "#!/bin/sh\necho hi\n",
      "vendor/tool.py": "import os\n",
      ".openqodex/config.yaml": "scanners:\n  disable: [shellcheck]\nreview:\n  paths:\n    exclude: [\"vendor/**\"]\n",
    });
    const dry = cli(s, ["init", "--dry-run", "--agent", "cursor"]);
    expect(dry.status, dry.stderr).toBe(0);
    const lines = dry.stdout.split("\n");
    const at = lines.indexOf("Scanners init would download for this repo:");
    expect(at, dry.stdout).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 4)).toEqual([
      "  semgrep: any file",
      "  gitleaks: any file",
      "  oxlint: JavaScript or TypeScript files, such as app/index.tsx; React and accessibility rules in the repository root",
    ]);
    expect(lines[at + 4]).not.toMatch(/^  /);
    expect(existsSync(join(s.oqHome, "tools"))).toBe(false);
  });

  it("22. picks the downloads from tracked and untracked files alike, names why for each, and leaves out a scanner the config switches off", () => {
    const s = sandbox({ "deploy.sh": "#!/bin/sh\necho hi\n", ".openqodex/config.yaml": "scanners:\n  disable: [gitleaks]\n" });
    writeFileSync(join(s.repo, "app.py"), "print('hi')\n");
    lockTools(s);
    const r = cli(s, ["init", "--yes", "--agent", "cursor"]);
    expect(r.status, r.stderr).toBe(0);
    // One reason line per scanner.
    expect(r.stdout).toContain("\n  shellcheck: shell scripts, such as deploy.sh\n");
    const lines = r.stdout.split("\n");
    const at = lines.indexOf("Downloading the scanners this repo needs in the background:");
    expect(at, r.stdout).toBeGreaterThan(-1);
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => !l.startsWith("  "));
    const line = rest.slice(0, end === -1 ? rest.length : end).map((l) => l.trim().split(":")[0]!);
    expect(line).toEqual(expect.arrayContaining(["shellcheck", "ruff", "bandit"]));
    expect(line).not.toContain("gitleaks");
    expect(line).not.toContain("oxlint");
  });
});

const SECTION_START = "<!-- openqodex:start -->";

describe("init, the hook question and the instruction section", () => {
  it("24. with a pre-push hook it did not write, or husky, does not say every push is checked, and says what to add", () => {
    const foreign = sandbox();
    writeFileSync(join(foreign.repo, ".git/hooks/pre-push"), "#!/bin/sh\necho mine\n");
    chmodSync(join(foreign.repo, ".git/hooks/pre-push"), 0o755);
    const husky = sandbox({ ".husky/pre-commit": "npm test\n" });
    for (const s of [foreign, husky]) {
      const r = cli(s, ["init", "--yes", "--agent", "claude-code"]);
      expect(r.status, r.stderr).toBe(0);
      const end = r.stdout.slice(r.stdout.lastIndexOf("is installed for"));
      expect(end).not.toContain("Every push from this repo is now checked");
      expect(end).toMatch(/git pre-push hook is not set up: .*add .*hook pre-push/);
    }
    expect(readFileSync(join(foreign.repo, ".git/hooks/pre-push"), "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("23. --yes keeps both choices this repo recorded (--no-repo, --hook none) and takes the defaults only where none was made", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--no-repo", "--hook", "none", "--agent", "claude-code"]).status).toBe(0);
    const again = cli(s, ["init", "--yes", "--agent", "claude-code"]);
    expect(again.status, again.stderr).toBe(0);
    expect(existsSync(join(s.repo, ".git/hooks/pre-push"))).toBe(false);
    expect(existsSync(join(s.repo, "CLAUDE.md"))).toBe(false);
    expect(again.stdout).toContain("git pre-push hook: left out, as this repo chose before");
    expect(again.stdout).toContain("team review section: left out, as this repo chose before");
    // Another repo answered nothing yet: --yes takes the defaults there.
    const other = sandbox();
    other.home = s.home;
    other.oqHome = s.oqHome;
    expect(cli(other, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    expect(existsSync(join(other.repo, ".git/hooks/pre-push"))).toBe(true);
    expect(existsSync(join(other.repo, "CLAUDE.md"))).toBe(true);
  });

  it("uninstall removes the global section and the hook, and keeps the developer's own text around the section", () => {
    const s = sandbox();
    const claudeMd = join(s.home, ".claude/CLAUDE.md");
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    writeFileSync(claudeMd, "# Mine\n\nKeep me.\n");
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    const installed = readFileSync(claudeMd, "utf8");
    expect(installed).toContain(SECTION_START);
    expect(installed).toContain("review the change with the openqodex skill");
    writeFileSync(claudeMd, `${installed}\nMore of mine.\n`);

    const r = cli(s, ["init", "--uninstall", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    const left = readFileSync(claudeMd, "utf8");
    expect(left.startsWith("# Mine\n\nKeep me.\n")).toBe(true);
    expect(left.trimEnd().endsWith("More of mine.")).toBe(true);
    expect(left).not.toContain("openqodex");
    expect(existsSync(join(s.repo, ".git/hooks/pre-push"))).toBe(false);
  });

  it("--project writes the section into the repo's CLAUDE.md and AGENTS.md", () => {
    const s = sandbox({ "CLAUDE.md": "# Repo\n" });
    expect(cli(s, ["init", "--yes", "--project", "--agent", "all"]).status).toBe(0);
    const claudeMd = readFileSync(join(s.repo, "CLAUDE.md"), "utf8");
    expect(claudeMd.startsWith("# Repo\n")).toBe(true);
    expect(claudeMd).toContain(SECTION_START);
    expect(readFileSync(join(s.repo, "AGENTS.md"), "utf8")).toContain(SECTION_START);
  });
});

describe("16. init, custom agent homes", () => {
  it("with CLAUDE_CONFIG_DIR set, writes the Claude Code skill, instructions, hook and rules there and nothing in ~/.claude", () => {
    const s = sandbox();
    const config = join(s.root, "claude config");
    const r = cli(s, ["init", "--yes", "--agent", "claude-code"], { env: { CLAUDE_CONFIG_DIR: config } });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(config, "skills/openqodex/SKILL.md"))).toBe(true);
    expect(readFileSync(join(config, "CLAUDE.md"), "utf8")).toContain(SECTION_START);
    expect(ourCommands(join(config, "settings.json"))).toHaveLength(1);
    expect(readJson<{ permissions: { allow: string[] } }>(join(config, "settings.json")).permissions.allow.length).toBeGreaterThan(0);
    expect(existsSync(join(s.home, ".claude"))).toBe(false);
    const un = cli(s, ["init", "--uninstall", "--yes"], { env: { CLAUDE_CONFIG_DIR: config } });
    expect(un.status, un.stderr).toBe(0);
    expect(existsSync(join(config, "skills/openqodex/SKILL.md"))).toBe(false);
  });

  it("with CODEX_HOME set, puts the Codex push hook beside its AGENTS.md there, and the skill in ~/.agents/skills", () => {
    const s = sandbox();
    const codexHome = join(s.root, "codex home");
    const r = cli(s, ["init", "--yes", "--agent", "codex"], { env: { CODEX_HOME: codexHome } });
    expect(r.status, r.stderr).toBe(0);
    expect(ourCommands(join(codexHome, "hooks.json"))).toHaveLength(1);
    expect(readFileSync(join(codexHome, "AGENTS.md"), "utf8")).toContain(SECTION_START);
    expect(existsSync(join(s.home, ".agents/skills/openqodex/SKILL.md"))).toBe(true);
    expect(existsSync(join(s.home, ".codex"))).toBe(false);
  });

  it("finds Claude Code and Codex by CLAUDE_CONFIG_DIR and CODEX_HOME when neither program is on PATH", () => {
    const s = sandbox();
    const config = join(s.root, "claude config");
    const codexHome = join(s.root, "codex home");
    mkdirSync(config);
    mkdirSync(codexHome);
    const r = cli(s, ["init", "--yes", "--dry-run"], { env: { CLAUDE_CONFIG_DIR: config, CODEX_HOME: codexHome } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(join(config, "skills/openqodex/SKILL.md"));
    expect(r.stdout).toContain(join(codexHome, "hooks.json"));
  });

  it("26. an agent folder inside the repository gets the repository's link rule: a committed settings.json link to outside is refused", () => {
    const s = sandbox();
    const outside = join(s.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "settings.json"), "{}\n");
    mkdirSync(join(s.repo, ".claude"));
    symlinkSync(join(outside, "settings.json"), join(s.repo, ".claude/settings.json"));
    const r = cli(s, ["init", "--yes", "--agent", "claude-code"], { env: { CLAUDE_CONFIG_DIR: join(s.repo, ".claude") } });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toContain("symbolic link inside the repository");
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("{}\n");
  });

  it("26. a link the repository swaps in after the plan is shown is refused at the write", () => {
    const s = sandbox();
    const outside = join(s.root, "outside");
    mkdirSync(outside);
    const config = join(s.repo, ".claude");
    const swap = `rm -rf '${config}' && ln -s '${outside}' '${config}'`;
    const r = inTerminal(s, ["init", "--agent", "claude-code"], [["Write these files?", "\r", swap]], { env: { CLAUDE_CONFIG_DIR: config } });
    expect(r.status, r.stdout).toBe(2);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("27. a write decides from where the path really lands, not from its spelling", () => {
  // init with Claude Code's folder named by `config`: exit code, and what
  // `outside` holds afterwards.
  function initWith(s: Sandbox, config: string): ReturnType<typeof cli> {
    return cli(s, ["init", "--yes", "--agent", "claude-code"], { env: { CLAUDE_CONFIG_DIR: config } });
  }

  it("a path whose . and .. segments resolve inside the home folder is written there", () => {
    const s = sandbox();
    mkdirSync(join(s.home, "x"));
    const r = initWith(s, `${s.home}/./x/../.claude`);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(s.home, ".claude/skills/openqodex/SKILL.md"))).toBe(true);
  });

  it("a folder spelled with a doubled separator, a ./ and a trailing slash is the same folder, and a second run changes nothing", () => {
    const s = sandbox();
    const spelled = `${s.home}//./.claude/`;
    expect(initWith(s, spelled).status).toBe(0);
    expect(existsSync(join(s.home, ".claude/skills/openqodex/SKILL.md"))).toBe(true);
    const before = snapshot(s);
    const again = initWith(s, spelled);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("Nothing to change");
    expect(snapshot(s)).toEqual(before);
  });

  it("an agent folder configured with .. in it is written where it resolves, the folder the agent reads", () => {
    const s = sandbox();
    const r = initWith(s, `${s.home}/../agent config`);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(s.root, "agent config/skills/openqodex/SKILL.md"))).toBe(true);
  });

  it("the repository spelled in another case keeps the repository's rule on a volume that folds case, and is another folder on one that keeps it", () => {
    const s = sandbox();
    const outside = join(s.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(s.repo, ".claude"));
    const flipped = join(s.root, "THE REPO");
    const folds = sameFolder(s.repo, flipped);
    expectSpelling(initWith(s, join(flipped, ".claude")), folds, join(flipped, ".claude"), join(s.repo, ".claude"), outside);
  });
});

// The write guard every file init writes goes through (src/agents/plan.ts),
// built with the folders init builds it with (src/commands/init.ts): the
// repository, its git folders, the home folder, the agents' folders and
// OpenQodex's home. The case "26. an agent folder inside the repository"
// above proves init's writes go through it and checks the reason it gives.
// Each row: a sandbox with a link, the file init would write, and the folder
// outside, which must hold afterwards what it held before.
describe("9, 26, 27 and 28. the write guard refuses a write through a repository link or outside every folder init writes", () => {
  type Row = { repo?: string; config?: string; target: string; outside: string };
  const outsideOf = (s: Sandbox): string => {
    const outside = join(s.root, "outside");
    mkdirSync(outside, { recursive: true });
    return outside;
  };
  // Spelled as given, not joined: a join would fold the .. before the link.
  const skillIn = (config: string): string => `${config}/skills/openqodex/SKILL.md`;
  const rows: [string, (s: Sandbox) => Row][] = [
    [
      "9. a .cursor/rules folder that links outside the repo",
      (s) => {
        const outside = outsideOf(s);
        mkdirSync(join(s.repo, ".cursor"));
        symlinkSync(outside, join(s.repo, ".cursor/rules"));
        return { target: join(s.repo, ".cursor/rules/openqodex.mdc"), outside };
      },
    ],
    [
      "26. a folder link the repository holds, on the way to an agent folder named from outside it",
      (s) => {
        const outside = outsideOf(s);
        // The developer's own link, outside the repo, into a folder the repo holds as a link.
        symlinkSync(outside, join(s.repo, "cfg"));
        symlinkSync(join(s.repo, "cfg"), join(s.root, "via"));
        return { config: join(s.root, "via"), target: skillIn(join(s.root, "via")), outside };
      },
    ],
    [
      "27. a parent folder link in the repository that points outside",
      (s) => {
        const outside = outsideOf(s);
        symlinkSync(outside, join(s.repo, ".claude"));
        return { config: join(s.repo, ".claude"), target: skillIn(join(s.repo, ".claude")), outside };
      },
    ],
    [
      "27. a work-tree name that starts with two dots is inside the repository",
      (s) => {
        const outside = outsideOf(s);
        symlinkSync(outside, join(s.repo, "..cfg"));
        return { config: `${s.repo}/..cfg`, target: skillIn(`${s.repo}/..cfg`), outside };
      },
    ],
    [
      "27. a .. after a link the repository holds is taken after the link, as the system takes it",
      (s) => {
        const outside = outsideOf(s);
        mkdirSync(join(outside, "deep"));
        symlinkSync(join(outside, "deep"), join(s.repo, "lnk"));
        // Spelled, this is the repo's own "evil"; the system lands in outside/evil.
        return { config: `${s.repo}/lnk/../evil`, target: skillIn(`${s.repo}/lnk/../evil`), outside };
      },
    ],
    [
      "27. a settings link whose .. segments resolve outside every folder init may write",
      (s) => {
        const outside = outsideOf(s);
        writeFileSync(join(outside, "settings.json"), "{}\n");
        mkdirSync(join(s.home, ".claude"));
        // From ~/.claude, ../../outside is the sandbox's outside folder.
        symlinkSync("../../outside/settings.json", join(s.home, ".claude/settings.json"));
        return { config: join(s.home, ".claude"), target: join(s.home, ".claude/settings.json"), outside };
      },
    ],
    [
      "27. a settings link into a sibling of the home folder that shares its name prefix",
      (s) => {
        const sibling = `${s.home}2`;
        mkdirSync(sibling);
        writeFileSync(join(sibling, "settings.json"), "{}\n");
        mkdirSync(join(s.home, ".claude"));
        symlinkSync(join(sibling, "settings.json"), join(s.home, ".claude/settings.json"));
        return { config: join(s.home, ".claude"), target: join(s.home, ".claude/settings.json"), outside: sibling };
      },
    ],
    [
      "28. a work tree inside its bare repository: the common git folder does not exempt the work tree's links",
      (s) => {
        const bare = join(s.root, "repo.git");
        git(s.root, "clone", "-q", "--bare", s.repo, bare);
        git(bare, "worktree", "add", "-q", join(bare, "main"), "main");
        const work = join(bare, "main");
        const outside = outsideOf(s);
        symlinkSync(outside, join(work, ".claude"));
        return { repo: work, config: join(work, ".claude"), target: skillIn(join(work, ".claude")), outside };
      },
    ],
  ];
  it.each(rows)("%s is refused, and nothing lands outside", async (_name, build) => {
    const s = sandbox();
    const row = build(s);
    const repo = row.repo ?? s.repo;
    const before = tree(row.outside);
    const guard = new Guard({ repoRoot: repo, gitFolders: await gitDirs(repo), roots: [s.home, row.config ?? join(s.home, ".claude"), join(s.home, ".codex"), s.oqHome] });
    expect(() => guard.write(row.target, "written\n")).toThrow();
    expect(tree(row.outside)).toEqual(before);
  });

  // The control: built this way, the guard writes where init may, so a row
  // above passes only for its link.
  it("a write into the agent folder in the home folder is made", async () => {
    const s = sandbox();
    const guard = new Guard({ repoRoot: s.repo, gitFolders: await gitDirs(s.repo), roots: [s.home, join(s.home, ".claude"), join(s.home, ".codex"), s.oqHome] });
    guard.write(skillIn(join(s.home, ".claude")), "written\n");
    expect(readFileSync(skillIn(join(s.home, ".claude")), "utf8")).toBe("written\n");
  });
});

describe("28. writes decide by filesystem identity, through checked handles", () => {
  // A repo of its own name under the sandbox root, with one commit.
  function namedRepo(s: Sandbox, name: string): string {
    const repo = join(s.root, name);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start");
    return repo;
  }
  const flipCase = (p: string): string => [...p].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");

  it("a repo named with digits only, its config folder spelled in another case: the repo's link is refused where the volume folds case, and the other spelling is another folder where it keeps it", () => {
    const s = sandbox();
    const repo = namedRepo(s, "123");
    const outside = join(s.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(repo, ".claude"));
    // Only the sandbox root above the repo has letters to flip; its own name
    // only, so the other spelling can be made where the volume keeps case.
    const root = join(dirname(s.root), flipCase(basename(s.root)));
    // Where the volume keeps case, init makes this other spelling as a new
    // folder beside the sandbox.
    adoptTempDir(root);
    const folds = sameFolder(repo, join(root, "123"));
    const spelled = join(root, "123", ".claude");
    const r = cli(s, ["init", "--yes", "--agent", "claude-code"], { cwd: repo, env: { CLAUDE_CONFIG_DIR: spelled } });
    expectSpelling(r, folds, spelled, join(repo, ".claude"), outside);
  });

  it("an accented repo name spelled in the other Unicode normalisation: the repo's link is refused where the volume folds it, and the other spelling is another folder where it keeps it", () => {
    const s = sandbox();
    // The name in NFC, then spelled in NFD.
    const repo = namedRepo(s, "caf\u00e9");
    const outside = join(s.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(repo, ".claude"));
    const other = join(s.root, "cafe\u0301");
    const folds = sameFolder(repo, other);
    const spelled = join(other, ".claude");
    const r = cli(s, ["init", "--yes", "--agent", "claude-code"], { cwd: repo, env: { CLAUDE_CONFIG_DIR: spelled } });
    expectSpelling(r, folds, spelled, join(repo, ".claude"), outside);
  });

  it("install.json as a link to a file outside: the file outside is not replaced", () => {
    const s = sandbox();
    const outside = join(s.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "victim.json"), "{}\n");
    mkdirSync(s.oqHome, { recursive: true });
    symlinkSync(join(outside, "victim.json"), join(s.oqHome, "install.json"));
    const r = cli(s, ["init", "--yes", "--agent", "claude-code"]);
    expect(r.status).toBe(2);
    expect(readFileSync(join(outside, "victim.json"), "utf8")).toBe("{}\n");
  });

  it("runtime as a link to a folder outside with a stale version in it: nothing outside is deleted", () => {
    const s = sandbox();
    const cache = join(s.root, "cache");
    const stale = join(cache, "0.0.1");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "package.json"), JSON.stringify({ name: "openqodex", version: "0.0.1" }));
    const longAgo = new Date(Date.now() - 60 * 24 * 3600_000);
    utimesSync(stale, longAgo, longAgo);
    mkdirSync(s.oqHome, { recursive: true });
    symlinkSync(cache, join(s.oqHome, "runtime"));
    // The runtime copy cannot be written through the link, so init fails.
    const r = cli(s, ["init", "--yes", "--agent", "claude-code"]);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(existsSync(join(stale, "package.json"))).toBe(true);
    expect(readdirSync(cache)).toEqual(["0.0.1"]);
  });

  it("a terminal run with --hook none on an unchanged install asks before it records the choice", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    const record = readFileSync(join(s.oqHome, "install.json"), "utf8");
    const r = inTerminal(s, ["init", "--hook", "none", "--agent", "claude-code"], [["Write these files?", "n"]]);
    expect(r.status, r.stdout).toBe(0);
    expect(promptsAsked(r.stdout)).toContain("Write these files?");
    expect(readFileSync(join(s.oqHome, "install.json"), "utf8")).toBe(record);
  });
});
