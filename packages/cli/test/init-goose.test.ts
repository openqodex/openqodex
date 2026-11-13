// `openqodex init` for Goose (issue 226), run as the real built CLI in temp
// homes and temp repos. Goose is not installed here: these tests hold what
// init writes to the files Goose's documentation names, not what Goose does
// with them.
//
// Ways it could fail, written before the code:
//  1. `--agent goose` is refused, `--agent all` leaves Goose out, or the
//     unknown-agent error and the no-agent list do not name it.
//  2. Goose is not found by its config folder, or is found by a program
//     named goose on PATH, which is often another tool (the pressly/goose
//     database migration tool).
//  9. With XDG_CONFIG_HOME or GOOSE_PATH_ROOT set, init looks for Goose in
//     one folder and writes its files in another, or in ~/.config/goose,
//     which Goose then does not read; or a relative value is followed,
//     which Goose ignores.
//  3. A Goose install writes a file another agent's setup writes or claims
//     (the shared `.agents/skills` skill, `AGENTS.md`), or any file beyond
//     its own hints section and skill, in either scope.
//  4. A second init rewrites a file or adds a second section.
//  5. Uninstall leaves the section behind, or changes the developer's own
//     lines before and after it in `.goosehints`.
//  6. With Codex and Goose both installed, uninstalling one changes or
//     removes a file of the other, or removes the launcher the Goose skill
//     still calls.
//  7. A Goose section an earlier version wrote, still as recorded, is not
//     counted as a file init refreshes, or init does not refresh it.
//  8. The plan says nothing about the push hook and the MCP server that init
//     does not write for Goose.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agentFreePath, cli, env, sandbox, snapshot, type Sandbox } from "./init-helpers.js";
import { globalSection, instructionSection, SECTION_END, SECTION_START } from "../src/agents/targets.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const gooseHints = (s: Sandbox): string => join(s.home, ".config/goose/.goosehints");
const gooseSkill = (s: Sandbox): string => join(s.home, ".config/goose/skills/openqodex/SKILL.md");
const launcher = (s: Sandbox): string => join(s.oqHome, "bin/openqodex");

// A user-scope run from the home folder, outside any repository, so only the
// agent files and ~/.openqodex change.
function user(s: Sandbox, args: string[]) {
  return cli(s, ["init", "--yes", ...args], { cwd: s.home });
}

// A project-scope run in the repository, with no git hook to keep the
// changed files to the agent files and the team files in .openqodex/.
function project(s: Sandbox, args: string[]) {
  return cli(s, ["init", "--yes", "--project", "--hook", "none", ...args]);
}

// Paths under the sandbox that differ between two snapshots, less
// ~/.openqodex (launcher, runtime, record) and the repository's .git and
// .openqodex folders, which every init touches whatever the agent.
function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  const own = /^(home dir\/\.openqodex\/|the repo\/\.git\/|the repo\/\.openqodex\/)/;
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((p) => before[p] !== after[p] && !own.test(p)).sort();
}

function bytes(paths: string[]): Record<string, string | null> {
  return Object.fromEntries(paths.map((p) => [p, existsSync(p) ? readFileSync(p, "utf8") : null]));
}

describe("1. naming Goose", () => {
  it("--agent goose and --agent all plan Goose's files; an unknown agent's error names goose", () => {
    const s = sandbox();
    const one = cli(s, ["init", "--dry-run", "--agent", "goose"], { cwd: s.home });
    expect(one.status, one.stderr).toBe(0);
    expect(one.stdout).toContain(gooseHints(s));
    const all = cli(s, ["init", "--dry-run", "--agent", "all"], { cwd: s.home });
    expect(all.status, all.stderr).toBe(0);
    expect(all.stdout).toContain(gooseSkill(s));
    const bad = cli(s, ["init", "--dry-run", "--agent", "gooose"], { cwd: s.home });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("Choose claude-code, cursor, codex, cline, goose or all.");
    expect(bad.stderr).toContain("--agent <claude-code|cursor|codex|cline|goose|all>");
  });
});

describe("2. finding Goose", () => {
  // Agent detection also sees a real system Cursor installation.
  it.skipIf(existsSync("/Applications/Cursor.app"))("with nothing found, the list names goose", () => {
    const s = sandbox();
    const r = cli(s, ["init", "--yes", "--dry-run"], { cwd: s.home });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--agent goose    Goose");
  });

  it("not by a program named goose on PATH alone, which may be another tool; detection never runs it", () => {
    const s = sandbox();
    const bin = tempDir("oq-goose-bin-");
    writeFileSync(join(bin, "goose"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "goose"), 0o755);
    const r = cli(s, ["init", "--dry-run"], { cwd: s.home, env: { PATH: [bin, agentFreePath()].join(delimiter) } });
    expect(r.stdout + r.stderr).not.toContain(gooseHints(s));
  });

  it("by its config folder, ~/.config/goose", () => {
    const s = sandbox();
    const without = cli(s, ["init", "--dry-run"], { cwd: s.home });
    expect(without.stdout + without.stderr).not.toContain(".config/goose");
    mkdirSync(join(s.home, ".config/goose"), { recursive: true });
    const r = cli(s, ["init", "--dry-run"], { cwd: s.home });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(gooseHints(s));
  });
});

describe("3, 4 and 8. what init writes for Goose", () => {
  it("user scope: the one-line section in ~/.config/goose/.goosehints and the skill stub beside it, nothing else; a second run changes nothing", () => {
    const s = sandbox();
    const before = snapshot(s);
    const r = user(s, ["--agent", "goose"]);
    expect(r.status, r.stderr).toBe(0);
    const after = snapshot(s);
    expect(changed(before, after)).toEqual(["home dir/.config/goose/.goosehints", "home dir/.config/goose/skills/openqodex/SKILL.md"]);
    expect(readFileSync(gooseHints(s), "utf8")).toBe(`${globalSection()}\n`);
    const skill = readFileSync(gooseSkill(s), "utf8");
    expect(skill).toMatch(/^---\nname: openqodex\ndescription: /);
    expect(skill).toContain(`'${launcher(s)}' guide skill`);
    expect(r.stdout).toMatch(/note +Goose push hook: not written/);
    expect(r.stdout).toMatch(/note +Goose MCP server for the code graph: not written/);
    expect(r.stdout).toContain(`Add it under "extensions" in ${join(s.home, ".config/goose/config.yaml")}: openqodex: {`);
    const again = user(s, ["--agent", "goose"]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("Nothing to change");
    expect(snapshot(s)).toEqual(after);
  });

  it("project scope: the instruction section in .goosehints and the pinned skill in .goose/skills, nothing else; a second run changes nothing", () => {
    const s = sandbox();
    const before = snapshot(s);
    const r = project(s, ["--agent", "goose"]);
    expect(r.status, r.stderr).toBe(0);
    const after = snapshot(s);
    expect(changed(before, after)).toEqual(["the repo/.goose/skills/openqodex/SKILL.md", "the repo/.goosehints"]);
    expect(readFileSync(join(s.repo, ".goosehints"), "utf8")).toBe(`${instructionSection()}\n`);
    expect(readFileSync(join(s.repo, ".goose/skills/openqodex/SKILL.md"), "utf8")).toMatch(/npx -y openqodex@\d+\.\d+\.\d+/);
    expect(r.stdout).toMatch(/note +Goose push hook: not written/);
    expect(r.stdout).toMatch(/note +Goose MCP server for the code graph: not written/);
    const again = project(s, ["--agent", "goose"]);
    expect(again.status, again.stderr).toBe(0);
    expect(snapshot(s)).toEqual(after);
  });
});

describe("5. uninstall keeps the developer's own hints", () => {
  it("user scope: lines before and after the section stay byte for byte", () => {
    const s = sandbox();
    mkdirSync(join(s.home, ".config/goose"), { recursive: true });
    writeFileSync(gooseHints(s), "Use TypeScript.\n");
    expect(user(s, ["--agent", "goose"]).status).toBe(0);
    const text = readFileSync(gooseHints(s), "utf8");
    expect(text).toBe(`Use TypeScript.\n\n${globalSection()}\n`);
    writeFileSync(gooseHints(s), `${text}Run the tests first.\n`);
    const un = user(s, ["--uninstall", "--agent", "goose"]);
    expect(un.status, un.stderr).toBe(0);
    expect(readFileSync(gooseHints(s), "utf8")).toBe("Use TypeScript.\n\nRun the tests first.\n");
    expect(existsSync(gooseSkill(s))).toBe(false);
  });

  it("project scope: a section in the middle of the team's .goosehints goes, the lines around it stay", () => {
    const s = sandbox({ ".goosehints": `Use TypeScript.\n${instructionSection()}\nRun the tests first.\n` });
    expect(project(s, ["--agent", "goose"]).status).toBe(0);
    expect(readFileSync(join(s.repo, ".goosehints"), "utf8").split(SECTION_START)).toHaveLength(2);
    const un = cli(s, ["init", "--yes", "--uninstall", "--project", "--agent", "goose"]);
    expect(un.status, un.stderr).toBe(0);
    expect(readFileSync(join(s.repo, ".goosehints"), "utf8")).toBe("Use TypeScript.\nRun the tests first.\n");
    expect(readFileSync(join(s.repo, ".goosehints"), "utf8")).not.toContain(SECTION_END);
  });
});

describe("6. Codex and Goose installed together", () => {
  const files = (s: Sandbox, scope: "user" | "project") =>
    scope === "user"
      ? {
          codex: [join(s.home, ".agents/skills/openqodex/SKILL.md"), join(s.home, ".codex/AGENTS.md"), join(s.home, ".codex/hooks.json"), join(s.home, ".codex/config.toml")],
          goose: [gooseHints(s), gooseSkill(s)],
        }
      : {
          codex: [join(s.repo, ".agents/skills/openqodex/SKILL.md"), join(s.repo, "AGENTS.md"), join(s.repo, ".codex/hooks.json"), join(s.repo, ".codex/config.toml")],
          goose: [join(s.repo, ".goosehints"), join(s.repo, ".goose/skills/openqodex/SKILL.md")],
        };
  const run = (s: Sandbox, scope: "user" | "project", args: string[]) => (scope === "user" ? user(s, args) : project(s, args));

  it.each([
    ["user", "codex", "goose", "goose"],
    ["user", "codex", "goose", "codex"],
    ["user", "goose", "codex", "goose"],
    ["user", "goose", "codex", "codex"],
    ["project", "codex", "goose", "goose"],
    ["project", "codex", "goose", "codex"],
    ["project", "goose", "codex", "goose"],
    ["project", "goose", "codex", "codex"],
  ] as const)("%s scope, %s then %s: uninstalling %s leaves every file of the other as it was", (scope, first, second, removed) => {
    const s = sandbox();
    expect(run(s, scope, ["--agent", first]).status).toBe(0);
    expect(run(s, scope, ["--agent", second]).status).toBe(0);
    const kept = removed === "goose" ? "codex" : "goose";
    const keptFiles = files(s, scope)[kept];
    const keptBefore = bytes(keptFiles);
    for (const text of Object.values(keptBefore)) expect(text).not.toBeNull();
    const un = run(s, scope, ["--uninstall", "--agent", removed]);
    expect(un.status, un.stderr).toBe(0);
    expect(bytes(keptFiles)).toEqual(keptBefore);
    for (const p of files(s, scope)[removed]) expect(existsSync(p), p).toBe(false);
    if (scope === "user") {
      // Both keep using the launcher: Codex's hook and Goose's skill call it.
      const r = spawnSync("sh", [launcher(s), "guide", "skill"], { encoding: "utf8", env: env(s), cwd: s.repo });
      expect(r.status, r.stderr).toBe(0);
    }
  });
});

describe("7. a Goose section an earlier version wrote", () => {
  it("is counted as a file init refreshes, and init replaces it and keeps the developer's lines", () => {
    const s = sandbox();
    expect(user(s, ["--agent", "goose"]).status).toBe(0);
    const older = `${SECTION_START}\nAn older trigger line.\n${SECTION_END}`;
    writeFileSync(gooseHints(s), `My hint.\n\n${older}\n`);
    const recordPath = join(s.oqHome, "install.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { sections: { path: string; text: string }[] };
    for (const section of record.sections) if (section.path === gooseHints(s)) section.text = older;
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    const status = spawnSync("sh", [launcher(s), "update", "--status"], { encoding: "utf8", env: env(s), cwd: s.home });
    expect(status.stdout).toMatch(/^agent files +1 OpenQodex wrote is from an older version/m);
    expect(user(s, ["--agent", "goose"]).status).toBe(0);
    expect(readFileSync(gooseHints(s), "utf8")).toBe(`My hint.\n\n${globalSection()}\n`);
    const after = spawnSync("sh", [launcher(s), "update", "--status"], { encoding: "utf8", env: env(s), cwd: s.home });
    expect(after.stdout).toMatch(/^agent files +up to date$/m);
  });
});

describe("9. Goose's config folder moved by the environment", () => {
  it("XDG_CONFIG_HOME: found in $XDG_CONFIG_HOME/goose, written there and nowhere in ~/.config, removed from there", () => {
    const s = sandbox();
    const xdg = realpathSync(tempDir("oq-xdg-"));
    const folder = join(xdg, "goose");
    const xenv = { XDG_CONFIG_HOME: xdg };
    mkdirSync(join(s.home, ".config/goose"), { recursive: true });
    // The folder under ~/.config does not count while XDG_CONFIG_HOME is set.
    expect(cli(s, ["init", "--dry-run"], { cwd: s.home, env: xenv }).stdout).not.toContain(".goosehints");
    mkdirSync(folder);
    const plan = cli(s, ["init", "--dry-run"], { cwd: s.home, env: xenv });
    expect(plan.stdout).toContain(join(folder, ".goosehints"));
    const r = cli(s, ["init", "--yes", "--agent", "goose"], { cwd: s.home, env: xenv });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(folder, ".goosehints"), "utf8")).toBe(`${globalSection()}\n`);
    expect(readFileSync(join(folder, "skills/openqodex/SKILL.md"), "utf8")).toContain(`'${launcher(s)}' guide skill`);
    expect(r.stdout).toContain(`Add it under "extensions" in ${join(folder, "config.yaml")}`);
    expect(existsSync(gooseHints(s))).toBe(false);
    expect(existsSync(gooseSkill(s))).toBe(false);
    const un = cli(s, ["init", "--yes", "--uninstall", "--agent", "goose"], { cwd: s.home, env: xenv });
    expect(un.status, un.stderr).toBe(0);
    expect(existsSync(join(folder, ".goosehints"))).toBe(false);
    expect(existsSync(join(folder, "skills/openqodex/SKILL.md"))).toBe(false);
  });

  it("a relative XDG_CONFIG_HOME is ignored, as Goose ignores it", () => {
    const s = sandbox();
    const r = cli(s, ["init", "--yes", "--agent", "goose"], { cwd: s.home, env: { XDG_CONFIG_HOME: "relative/config" } });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(gooseHints(s), "utf8")).toBe(`${globalSection()}\n`);
  });

  it("GOOSE_PATH_ROOT: the folder is $GOOSE_PATH_ROOT/config, ahead of XDG_CONFIG_HOME", () => {
    const s = sandbox();
    const root = realpathSync(tempDir("oq-goose-root-"));
    const r = cli(s, ["init", "--yes", "--agent", "goose"], { cwd: s.home, env: { GOOSE_PATH_ROOT: root, XDG_CONFIG_HOME: join(s.root, "xdg") } });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(root, "config/.goosehints"), "utf8")).toBe(`${globalSection()}\n`);
    expect(existsSync(join(root, "config/skills/openqodex/SKILL.md"))).toBe(true);
    expect(existsSync(join(s.root, "xdg"))).toBe(false);
  });
});
