// The launcher's runtime pointer and the team section in the repo, through
// the real built CLI in temp homes and temp repos.
//
// Ways it could fail, written before the code:
//  1. After init, the launcher (and so a hook or skill command) still runs
//     the version baked into it when runtime/current names a newer runtime
//     that is installed.
//  2. A current file holding a path traversal or shell metacharacters makes
//     the launcher run something other than an installed runtime.
//  3. current names a version whose folder is gone, and the launcher fails
//     instead of running the version baked into it.
//  4. init --agent cursor (no hook target) leaves no launcher, so the
//     installed skill's command does not exist.
//  5. The user-scope skill still runs `npx -y openqodex@`, so the agent's
//     review never follows the installed runtime.
//  6. A second init writes the team section again.
//  7. The team section is hidden from git status, so it is never committed.
//  8. --yes skips the team section, or --no-repo writes it.
//  9. --uninstall removes a section the developer edited, or leaves our
//     untouched section (or a file only it was in) behind.
// 10. A repo CLAUDE.md that is a symbolic link is written through.
// 11. The team section points at the openqodex skill, which a teammate with
//     nothing installed does not have.
// 12. The launcher's pointer code breaks under dash, the sh of Debian and
//     Ubuntu.
// 13. init --project and then init in user scope leave two sections in one
//     file.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BIN, cli, env, sandbox, snapshot, status, type Sandbox } from "./init-helpers.js";

const version = (JSON.parse(readFileSync(join(BIN, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const NEWER = "0.99.0";
const START = "<!-- openqodex:start -->";

function launcher(s: Sandbox): string {
  return join(s.oqHome, "bin/openqodex");
}

function runLauncher(s: Sandbox, args: string[], shell = "sh"): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(shell, [launcher(s), ...args], { encoding: "utf8", env: env(s), cwd: s.repo, timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// A second real runtime: the installed copy with its version string changed,
// so `--version` says which one ran.
function installNewer(s: Sandbox): void {
  const from = join(s.oqHome, "runtime", version);
  const to = join(s.oqHome, "runtime", NEWER);
  cpSync(from, to, { recursive: true });
  const bin = join(to, "dist/bin.js");
  writeFileSync(bin, readFileSync(bin, "utf8").replaceAll(`"${version}"`, `"${NEWER}"`));
}

function setCurrent(s: Sandbox, text: string): void {
  writeFileSync(join(s.oqHome, "runtime/current"), text);
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("the launcher follows runtime/current", () => {
  let s: Sandbox;
  beforeAll(() => {
    expect(existsSync(BIN), "build the CLI first (pnpm build)").toBe(true);
    s = sandbox();
    const r = cli(s, ["init", "--yes", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    installNewer(s);
  });

  it("init points current at the version it installed", () => {
    expect(readFileSync(join(s.oqHome, "runtime/current"), "utf8").trim()).toBe(version);
    expect(runLauncher(s, ["--version"]).stdout.trim()).toBe(version);
  });

  it("runs the runtime current names when it is installed (failure 1)", () => {
    setCurrent(s, `${NEWER}\n`);
    expect(runLauncher(s, ["--version"]).stdout.trim()).toBe(NEWER);
    setCurrent(s, NEWER);
    expect(runLauncher(s, ["--version"]).stdout.trim()).toBe(NEWER);
    const hook = runLauncher(s, ["hook", "check"]);
    expect(hook.status).toBe(0);
    setCurrent(s, `${version}\n`);
  });

  it("falls back to the baked-in version for a traversal or shell text in current (failure 2)", () => {
    const marker = join(s.root, "ran");
    for (const text of ["..", "../../..", `${NEWER}/../${NEWER}`, `$(touch '${marker}')`, `${NEWER};touch '${marker}'`, `\`touch ${marker}\``, ` ${NEWER}`, "-v"]) {
      setCurrent(s, `${text}\n`);
      const r = runLauncher(s, ["--version"]);
      expect(r.stdout.trim(), text).toBe(version);
      expect(existsSync(marker), text).toBe(false);
    }
    setCurrent(s, `${version}\n`);
  });

  it("falls back and runs when the runtime current names is gone (failure 3)", () => {
    setCurrent(s, "0.98.0\n");
    const r = runLauncher(s, ["--version"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(version);
    setCurrent(s, `${version}\n`);
  });

  it("works under dash, or sh where there is no dash (failure 12)", () => {
    const shell = existsSync("/bin/dash") ? "/bin/dash" : "sh";
    process.stdout.write(`launcher pointer test ran under ${shell}\n`);
    setCurrent(s, `${NEWER}\n`);
    expect(runLauncher(s, ["--version"], shell).stdout.trim()).toBe(NEWER);
    setCurrent(s, "../x\n");
    expect(runLauncher(s, ["--version"], shell).stdout.trim()).toBe(version);
    setCurrent(s, `${version}\n`);
  });
});

describe("the user-scope skill calls the launcher", () => {
  it("cursor alone gets the runtime and launcher, and the skill's command runs (failures 4 and 5)", () => {
    const s = sandbox();
    const r = cli(s, ["init", "--yes", "--agent", "cursor"]);
    expect(r.status, r.stderr).toBe(0);
    const skill = readFileSync(join(s.home, ".cursor/skills/openqodex/SKILL.md"), "utf8");
    expect(skill).not.toContain("npx -y openqodex@");
    const command = /^('[^']+') guide skill$/m.exec(skill)?.[1];
    expect(command).toBe(`'${launcher(s)}'`);
    const run = spawnSync("sh", ["-c", `${command} --version`], { encoding: "utf8", env: env(s) });
    expect(run.stdout.trim(), run.stderr).toBe(version);
  });

  it("project scope keeps the pinned npx command in the skill", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--project", "--agent", "claude-code"]).status).toBe(0);
    const skill = readFileSync(join(s.repo, ".claude/skills/openqodex/SKILL.md"), "utf8");
    expect(skill).toContain(`npx -y openqodex@${version} review --agent`);
    expect(skill).not.toContain(launcher(s));
  });
});

describe("the team section in the repo", () => {
  it("is written into CLAUDE.md and AGENTS.md once, shows in git status, never names the skill (failures 6, 7, 11)", () => {
    const s = sandbox();
    const first = cli(s, ["init", "--yes", "--agent", "claude-code"]);
    expect(first.status, first.stderr).toBe(0);
    for (const f of ["CLAUDE.md", "AGENTS.md"]) {
      const text = readFileSync(join(s.repo, f), "utf8");
      expect(count(text, START), f).toBe(1);
      expect(text).toContain(`npx -y openqodex@${version} review --agent`);
      expect(text.toLowerCase()).not.toContain("skill");
      expect(text).not.toContain(String.fromCodePoint(0x2014));
    }
    expect(status(s)).toContain("?? AGENTS.md\n");
    expect(status(s)).toContain("?? CLAUDE.md\n");
    expect(readFileSync(join(s.repo, ".git/info/exclude"), "utf8")).not.toMatch(/CLAUDE|AGENTS/);
    expect(first.stdout).toMatch(/Commit CLAUDE\.md and AGENTS\.md/);

    const before = snapshot(s);
    const second = cli(s, ["init", "--yes", "--agent", "claude-code"]);
    expect(second.status, second.stderr).toBe(0);
    expect(snapshot(s)).toEqual(before);
  });

  it("--yes writes it and --no-repo does not (failure 8)", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    expect(existsSync(join(s.repo, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(s.repo, "AGENTS.md"))).toBe(false);
    const t = sandbox();
    expect(cli(t, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    expect(existsSync(join(t.repo, "CLAUDE.md"))).toBe(true);
  });

  it("uninstall removes our section and a file only it was in, and keeps an edited one (failure 9)", () => {
    const s = sandbox({ "AGENTS.md": "# Agents\n\nBe nice.\n" });
    const statusBefore = status(s);
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(existsSync(join(s.repo, "CLAUDE.md"))).toBe(false);
    expect(readFileSync(join(s.repo, "AGENTS.md"), "utf8")).toBe("# Agents\n\nBe nice.\n");
    expect(status(s)).toBe(statusBefore);

    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    const claude = join(s.repo, "CLAUDE.md");
    const edited = readFileSync(claude, "utf8").replace("before you push", "before you push, always");
    expect(edited).not.toBe(readFileSync(claude, "utf8"));
    writeFileSync(claude, edited);
    const u = cli(s, ["init", "--uninstall", "--yes"]);
    expect(u.status, u.stderr).toBe(0);
    expect(readFileSync(claude, "utf8")).toBe(edited);
  });

  it("refuses a CLAUDE.md that is a symbolic link and leaves its target alone (failure 10)", () => {
    const s = sandbox();
    const outside = join(s.root, "outside.md");
    writeFileSync(outside, "mine\n");
    symlinkSync(outside, join(s.repo, "CLAUDE.md"));
    const r = cli(s, ["init", "--yes", "--agent", "claude-code"]);
    expect(readFileSync(outside, "utf8")).toBe("mine\n");
    expect(`${r.stdout}${r.stderr}`).toContain("symbolic link");
  });

  it("init --project then init leaves one section per file (failure 13)", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--project", "--agent", "claude-code", "--agent", "codex"]).status).toBe(0);
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    for (const f of ["CLAUDE.md", "AGENTS.md"]) expect(count(readFileSync(join(s.repo, f), "utf8"), START), f).toBe(1);
  });
});
