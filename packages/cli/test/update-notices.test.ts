// What the first command after an update says, and what doctor says about
// the last update, through the real built CLI and launcher in temp homes.
//
// Ways it could fail, written before the code:
//  1. After an update the next command names only the two versions, not a
//     change in what leaves the machine, what blocks a push or who reviews
//     (the 0.6.0 web default reached 0.5.0 installs without a word).
//  2. A release notice prints twice, or one outside the two versions prints.
//  3. After an update, files OpenQodex wrote that this version writes
//     differently go unmentioned, so an agent keeps an older procedure until
//     someone happens to run init; or a file the developer edited, which
//     init keeps, is counted.
//  4. doctor does not list the notices of the last update or the files
//     init would refresh.
//  5. update --status still names a release as waiting for a foreground
//     update once that release, or a newer one, runs.
//  8. A user-scope Cursor rule in a repository whose .cursor/rules is a link
//     into the home is counted as stale, though init refuses to write it.
//  9. With stale Cursor rules recorded in several repositories, the line says
//     one init refreshes them, which no single init can.
// 10. After an update, the global note an older init wrote (the one that
//     asks for a review in every repository) is not counted, so the agent
//     keeps it until someone happens to run init.
//  6. A notice of a change not yet released names a version chosen by hand,
//     so when changesets gives the release another number it prints after
//     the wrong update, or never.
//  7. The step that prepares the release (scripts/sync-version.mjs) leaves
//     a "next" notice as it is, or gives it another version than the
//     package's, so it never prints after the update to that release.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NOTICES, noticesBetween } from "../src/notices.js";
import { cli, env, sandbox, type Sandbox } from "./init-helpers.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const version = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;

function launch(s: Sandbox, args: string[]) {
  return spawnSync("sh", [join(s.oqHome, "bin/openqodex"), ...args], { encoding: "utf8", env: env(s), cwd: s.repo, timeout: 120_000 });
}

function installed(agents: string[]): Sandbox {
  const s = sandbox();
  const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", ...agents.flatMap((a) => ["--agent", a])]);
  expect(r.status, r.stderr).toBe(0);
  return s;
}

// The notice a worker of 0.8.1 or earlier leaves after it switched: the two
// versions in its text, no `from` field.
function switchedFrom(s: Sandbox, from: string): void {
  writeFileSync(join(s.oqHome, "update.json"), `${JSON.stringify({ notice: { version, text: `openqodex updated to ${version} (was ${from}). Roll back: openqodex update --rollback` } })}\n`);
  writeFileSync(join(s.oqHome, "runtime/current"), `${version}\n${from}\n`);
}

// A user-scope file as an older init wrote it and recorded it.
function asOlder(s: Sandbox, path: string, text: string): void {
  writeFileSync(path, text);
  const record = JSON.parse(readFileSync(join(s.oqHome, "install.json"), "utf8")) as { files: { path: string; sha256: string }[] };
  for (const f of record.files) if (f.path === path) f.sha256 = createHash("sha256").update(text).digest("hex");
  writeFileSync(join(s.oqHome, "install.json"), JSON.stringify(record, null, 2));
}

describe("after an update", () => {
  it("the next command prints every release notice after the old version, once, and none from before it (failures 1 and 2)", () => {
    const s = installed(["claude-code"]);
    switchedFrom(s, "0.5.0");
    const first = launch(s, ["guide", "config"]);
    const second = launch(s, ["guide", "config"]);
    expect(first.stderr).toContain(`openqodex updated to ${version} (was 0.5.0)`);
    const expected = noticesBetween("0.5.0", version);
    for (const n of expected) expect(first.stderr).toContain(`${n.version}: ${n.text}`);
    for (const n of NOTICES.filter((x) => !expected.includes(x))) expect(first.stderr).not.toContain(n.text);
    expect(second.stderr).not.toContain("openqodex updated");
    for (const n of NOTICES) expect(second.stderr).not.toContain(n.text);
  });

  it("names how many files OpenQodex wrote are from an older version, counting none the developer edited, and init refreshes them (failure 3)", () => {
    const s = installed(["claude-code", "cline"]);
    const skill = join(s.home, ".claude/skills/openqodex/SKILL.md");
    asOlder(s, skill, "---\nname: openqodex\ndescription: an older stub\n---\n\nRun the older procedure.\n");
    const rule = join(s.home, "Documents/Cline/Rules/openqodex.md");
    appendFileSync(rule, "\nMy own line.\n");
    switchedFrom(s, "0.5.0");
    const launcher = `'${join(s.oqHome, "bin/openqodex")}'`;
    const r = launch(s, ["guide", "config"]);
    expect(r.stderr).toContain(`1 file OpenQodex wrote is from an older version; run ${launcher} init to refresh them`);
    expect(cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code", "--agent", "cline"]).status).toBe(0);
    expect(readFileSync(skill, "utf8")).toContain("guide skill");
    expect(readFileSync(rule, "utf8")).toContain("My own line.");
    expect(launch(s, ["update", "--status"]).stdout).toMatch(/^agent files +up to date$/m);
  });
});

describe("the global note after an update", () => {
  it("counts the note an older init wrote, and init puts the current one in its place (failure 10)", () => {
    const s = installed(["claude-code"]);
    const file = join(s.home, ".claude/CLAUDE.md");
    const old = readFileSync(join(import.meta.dirname, "..", "templates", "previous", "global-0.9.0.md"), "utf8");
    writeFileSync(file, `My own rule.\n\n${old}`);
    const record = JSON.parse(readFileSync(join(s.oqHome, "install.json"), "utf8")) as { sections: { path: string; text: string }[] };
    for (const sec of record.sections) if (sec.path === file) sec.text = old.trimEnd();
    writeFileSync(join(s.oqHome, "install.json"), JSON.stringify(record, null, 2));
    switchedFrom(s, "0.5.0");
    expect(launch(s, ["guide", "config"]).stderr).toContain("1 file OpenQodex wrote is from an older version");
    expect(cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    const now = readFileSync(file, "utf8");
    expect(now.startsWith("My own rule.\n\n<!-- openqodex:start -->\nBefore any push in a repository that has an OpenQodex settings file")).toBe(true);
    expect(now).not.toContain(old.trimEnd());
    expect(now.split("<!-- openqodex:start -->").length).toBe(2);
  });
});

describe("doctor after an update", () => {
  it("lists the notices of the last update and the files init would refresh (failure 4)", () => {
    const s = installed(["claude-code"]);
    const skill = join(s.home, ".claude/skills/openqodex/SKILL.md");
    asOlder(s, skill, "an older stub\n");
    writeFileSync(join(s.oqHome, "runtime/current"), `${version}\n0.5.0\n`);
    const r = launch(s, ["doctor"]);
    for (const n of noticesBetween("0.5.0", version)) expect(r.stdout).toContain(`notice       ${n.version}: ${n.text}`);
    expect(r.stdout).toMatch(/^ {2}agent files +1 OpenQodex wrote is from an older version; run .* init to refresh them$/m);
  });
});

describe("a release left for a foreground update", () => {
  it("is named by update --status while it is newer than the version that runs, and not after (failure 5)", () => {
    const s = installed(["claude-code"]);
    const held = (v: string) => writeFileSync(join(s.oqHome, "update.json"), `${JSON.stringify({ held: { version: v, change: "how agents run a review" } })}\n`);
    held("99.0.0");
    expect(launch(s, ["update", "--status"]).stdout).toMatch(/^waiting +99\.0\.0 changes how agents run a review; openqodex update installs it$/m);
    held(version);
    expect(launch(s, ["update", "--status"]).stdout).not.toMatch(/^waiting/m);
  });
});

describe("the notice of a change not yet released", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const source = join(root, "packages/cli/src/notices.ts");

  it("carries no version until the release, and prints after no update meanwhile (failure 6)", () => {
    // On a release commit the version step has stamped every "next" notice,
    // so none is left; that is the released state, not a failure.
    expect(noticesBetween("0.0.1", "999.0.0").filter((n) => n.version === "next")).toEqual([]);
  });

  it("gets the package version from the release step, and then prints after the update to that version (failure 7)", async () => {
    const original = readFileSync(source, "utf8");
    // The step also stamps the first release that reads review.reviewers:
    // put back too, or a test run leaves the floor at this version.
    const floor = join(root, "packages/core/src/reviewers.ts");
    const floorOriginal = readFileSync(floor, "utf8");
    const was = NOTICES.filter((n) => n.version === "next").map((n) => n.text);
    try {
      execFileSync(process.execPath, [join(root, "scripts/sync-version.mjs")], { cwd: root, stdio: "pipe" });
      if (floorOriginal.includes("// release: next")) expect(readFileSync(floor, "utf8")).toContain(`export const REVIEWERS_SINCE = "${version}";\n`);
      const stamped = readFileSync(source, "utf8");
      expect(stamped).not.toMatch(/version: "next"/);
      // The module as the release builds it, from a fresh path so no cache answers.
      const copy = join(realpathSync(tempDir("oq-notices-")), "notices.ts");
      writeFileSync(copy, stamped);
      const { NOTICES: after, noticesBetween: between } = (await import(/* @vite-ignore */ pathToFileURL(copy).href)) as typeof import("../src/notices.js");
      for (const text of was) expect(after.find((n) => n.text === text)?.version, text).toBe(version);
      expect(between("0.0.1", version).map((n) => n.text)).toEqual(expect.arrayContaining(was));
    } finally {
      writeFileSync(source, original);
      writeFileSync(floor, floorOriginal);
    }
  });
});

describe("Cursor rules in repositories", () => {
  // A user-scope init for Cursor in each repository: its rule goes there.
  function installIn(s: Sandbox, repos: string[]): void {
    for (const repo of repos) {
      const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "dist", "bin.js"), "init", "--yes", "--hook", "none", "--no-repo", "--no-review", "--agent", "cursor"], { cwd: repo, env: env(s), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
    }
  }
  function gitRepo(s: Sandbox, name: string): string {
    const repo = join(s.root, name);
    spawnSync("git", ["init", "-q", repo]);
    return repo;
  }

  it("a rule behind a .cursor/rules link the repository holds is not counted: init would refuse it (failure 8)", () => {
    const s = sandbox();
    installIn(s, [s.repo]);
    const rule = join(s.repo, ".cursor/rules/openqodex.mdc");
    // The rules folder becomes a link into the home, holding the rule as an older init wrote it.
    const into = join(s.home, "rules elsewhere");
    mkdirSync(into, { recursive: true });
    rmSync(join(s.repo, ".cursor/rules"), { recursive: true });
    symlinkSync(into, join(s.repo, ".cursor/rules"));
    asOlder(s, rule, "an older rule\n");
    switchedFrom(s, "0.5.0");
    expect(launch(s, ["guide", "config"]).stderr).not.toMatch(/from an older version/);
  });

  it("names each repository whose rule is stale and says to run init in each (failure 9)", () => {
    const s = sandbox();
    const other = gitRepo(s, "other repo");
    installIn(s, [s.repo, other]);
    for (const repo of [s.repo, other]) asOlder(s, join(repo, ".cursor/rules/openqodex.mdc"), "an older rule\n");
    switchedFrom(s, "0.5.0");
    const launcher = `'${join(s.oqHome, "bin/openqodex")}'`;
    expect(launch(s, ["guide", "config"]).stderr).toContain(`2 files OpenQodex wrote are from an older version; run ${launcher} init in each of these repositories to refresh them: ${s.repo}, ${other}`);
  });
});
