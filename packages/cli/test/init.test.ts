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
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BIN, cli, env, git, sandbox, snapshot, status, type Sandbox } from "./init-helpers.js";

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

function userFiles(s: Sandbox): string[] {
  return [
    join(s.home, ".claude/skills/openqodex/SKILL.md"),
    join(s.home, ".claude/settings.json"),
    join(s.home, ".agents/skills/openqodex/SKILL.md"),
    join(s.home, ".codex/hooks.json"),
    join(s.home, ".cursor/skills/openqodex/SKILL.md"),
    join(s.repo, ".cursor/rules/openqodex.mdc"),
    join(s.home, ".cline/skills/openqodex/SKILL.md"),
    join(s.home, "Documents/Cline/Rules/openqodex.md"),
    join(s.home, ".claude/CLAUDE.md"),
    join(s.home, ".codex/AGENTS.md"),
    join(s.repo, ".git/hooks/pre-push"),
    join(s.oqHome, "bin/openqodex"),
    join(s.oqHome, "runtime", version, "dist/bin.js"),
  ];
}

// What a first init or scan adds to git status: the folder's .gitignore and
// the two team files, meant to be committed.
const REPO_FOLDER_STATUS = "?? .openqodex/.gitignore\n?? .openqodex/config.yaml\n?? .openqodex/custom-instructions.md\n";

describe("init, user scope, all agents", () => {
  let s: Sandbox;
  let statusBefore: string;
  let first: ReturnType<typeof cli>;

  beforeAll(() => {
    expect(existsSync(BIN), "build the CLI first (pnpm build)").toBe(true);
    s = sandbox();
    statusBefore = status(s);
    first = cli(s, ["init", "--yes", "--agent", "all"]);
  });

  it("writes every user-scope file the templates README lists; git status gains only the team files", () => {
    expect(first.status, first.stderr).toBe(0);
    for (const f of userFiles(s)) expect(existsSync(f), f).toBe(true);
    expect(status(s)).toBe(`${statusBefore}${REPO_FOLDER_STATUS}?? AGENTS.md\n?? CLAUDE.md\n`);
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

  it("changes nothing on a second run", () => {
    const before = snapshot(s);
    const second = cli(s, ["init", "--yes", "--agent", "all"]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("Nothing to change");
    expect(snapshot(s)).toEqual(before);
  });

  it("uninstall restores the starting state", () => {
    const r = cli(s, ["init", "--uninstall", "--yes"]);
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
    const dotfiles = join(s.root, "dotfiles");
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

  it("does not overwrite or remove a foreign rule file with the same name", () => {
    const s = sandbox();
    const rule = join(s.home, "Documents/Cline/Rules/openqodex.md");
    mkdirSync(join(rule, ".."), { recursive: true });
    writeFileSync(rule, "my own rule\n");
    expect(cli(s, ["init", "--yes", "--agent", "cline"]).status).toBe(0);
    cli(s, ["init", "--uninstall", "--yes"]);
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

describe("init, repository symlinks", () => {
  it("refuses a .cursor/rules folder that links outside the repo", () => {
    const s = sandbox();
    const outside = mkdtempSync(join(tmpdir(), "oq outside "));
    mkdirSync(join(s.repo, ".cursor"));
    symlinkSync(outside, join(s.repo, ".cursor/rules"));
    const r = cli(s, ["init", "--yes", "--agent", "cursor"]);
    expect(r.status).toBe(2);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true });
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
    cli(s, ["init", "--yes", "--project", "--agent", "codex"]);
    cli(s, ["init", "--uninstall", "--yes", "--project"]);
    expect(readFileSync(agents, "utf8")).toBe(edited);
  });
});

describe("init, writes nothing when it should not", () => {
  it("--dry-run writes nothing", () => {
    const s = sandbox();
    const before = snapshot(s);
    expect(cli(s, ["init", "--dry-run", "--agent", "all"]).status).toBe(0);
    expect(snapshot(s)).toEqual(before);
  });

  it("without a terminal and without --yes exits 2 and writes nothing", () => {
    const s = sandbox();
    const before = snapshot(s);
    const r = cli(s, ["init", "--agent", "claude-code"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--yes");
    expect(snapshot(s)).toEqual(before);
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
  it("starts the scanner installs this repo wants", () => {
    const s = sandbox({ "deploy.sh": "#!/bin/sh\necho hi\n" });
    lockTools(s);
    const r = cli(s, ["init", "--yes", "--agent", "cursor"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/background: .*shellcheck/);
  });
});

const SECTION_START = "<!-- openqodex:start -->";

describe("init, the hook question and the instruction section", () => {
  it("--yes adds the pre-push hook; a second run without --yes asks nothing and changes nothing", () => {
    const s = sandbox();
    const first = cli(s, ["init", "--yes", "--agent", "all"]);
    expect(first.status, first.stderr).toBe(0);
    expect(readFileSync(join(s.repo, ".git/hooks/pre-push"), "utf8")).toContain(join(s.oqHome, "bin/openqodex"));
    expect(first.stdout).toContain("Every push from this repo now gets a scan");
    const before = snapshot(s);
    // No terminal and no --yes: a run that had to ask or write would exit 2.
    const second = cli(s, ["init", "--agent", "all"]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("Nothing to change");
    expect(second.stdout).not.toContain("pre-push hook: not asked");
    expect(snapshot(s)).toEqual(before);
  });

  it("--hook none writes no hook, and a later --yes run keeps that answer", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--hook", "none", "--agent", "claude-code"]).status).toBe(0);
    expect(existsSync(join(s.repo, ".git/hooks/pre-push"))).toBe(false);
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    expect(existsSync(join(s.repo, ".git/hooks/pre-push"))).toBe(false);
  });

  it("uninstall removes the global section and the hook, and keeps the developer's own text around the section", () => {
    const s = sandbox();
    const claudeMd = join(s.home, ".claude/CLAUDE.md");
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    writeFileSync(claudeMd, "# Mine\n\nKeep me.\n");
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    const installed = readFileSync(claudeMd, "utf8");
    expect(installed).toContain(SECTION_START);
    expect(installed).toContain("separate subagent");
    writeFileSync(claudeMd, `${installed}\nMore of mine.\n`);

    const r = cli(s, ["init", "--uninstall", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    const left = readFileSync(claudeMd, "utf8");
    expect(left.startsWith("# Mine\n\nKeep me.\n")).toBe(true);
    expect(left.trimEnd().endsWith("More of mine.")).toBe(true);
    expect(left).not.toContain("openqodex");
    expect(existsSync(join(s.repo, ".git/hooks/pre-push"))).toBe(false);
  });

  it("writes the section into Codex's AGENTS.md under CODEX_HOME", () => {
    const s = sandbox();
    const codexHome = join(s.root, "codex home");
    expect(cli(s, ["init", "--yes", "--agent", "codex"], { env: { CODEX_HOME: codexHome } }).status).toBe(0);
    expect(readFileSync(join(codexHome, "AGENTS.md"), "utf8")).toContain(SECTION_START);
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
