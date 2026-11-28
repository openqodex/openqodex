// The tools a host's package manager installs. On FreeBSD, pkg installs
// shellcheck, ruff, hadolint, gitleaks, osv-scanner and zizmor under
// LOCALBASE, and OpenQodex never downloads or copies them. What this build
// does with such a tool, one case per test:
//  1. A program on PATH is never run: only the path under the localbase is
//     looked at, so two machines report the same findings.
//  2. A program that is not there is reported as not installed, and a
//     program that is there but cannot be used is refused with the reason
//     that says why.
//  3. A program that anyone can write to is refused with the words that it
//     is writable by group or others.
//  4. A program older than the pin is refused as too old, a program of
//     another series is refused as outside the pinned series, and a newer
//     patch of the pinned series is used.
//  5. A program that is there is reported with the version it printed and
//     not with the pin.
//  6. A system tool is not installed into the tools folder and leaves no
//     marker there.
//  7. A tool that is not a system asset is taken from its release asset.
//  8. A tool on Linux is not looked for in the localbase.
//  9. A program that hangs is refused when the version probe is out of time.
// 10. A version pattern this build cannot read is refused with the words
//     that this build cannot read a version from it.
// 11. A tool whose package is not the same on both architectures is judged
//     by the pin of the architecture it runs on.
// 12. A program that belongs to another user is refused with the words that
//     it is owned by another user, and a program that belongs to the system
//     or to this user is trusted.
// 13. A folder above the program that anyone can write to is refused with
//     the words that it is writable by group or others.
// 14. A folder above the program that belongs to another user is refused
//     with the words that it is owned by another user, and a folder that
//     belongs to the system or to this user and that nobody else can write
//     to is trusted.
// 15. A program inside the localbase is used when the localbase is the root
//     of the file system, and a path that is outside the root is not inside
//     it.
// 16. A program whose folder cannot be entered is refused with the error
//     that stopped it and is not reported as a package that is not
//     installed, and a program whose folder is a file and not a folder is
//     reported as a package that is not installed.
// 17. A program that is there but cannot be used is reported as unusable
//     and not as a package that is not installed.
// 18. The owner and the mode of a program are those of the program the link
//     points at and not those of the link.
// 19. The folder that holds the link to the program is walked too, so a
//     program another user can put there does not run the review.
// 20. A program is judged against the effective user, so a program of the
//     real user does not run the review when the build runs as another one.
// 21. A link whose target is not there is refused as a link whose target is
//     missing, and a program whose entry is not there at all is reported as
//     a package that is not installed.
// 22. A refusal about a program names the program that will run and not the
//     link that points at it.
// 23. The doctor reports the version the program printed and not the pin.
// 24. A folder and a program get the same words for the same owner and the
//     same mode.
// 25. A program that cannot be executed is refused with the words that it
//     is not executable, and the run itself is what decides.
// 26. A program of a localbase that is the root of the file system is never
//     reported as a package that is not installed and never as a program
//     outside the localbase.
// 27. A link whose target cannot be reached is refused with the error that
//     stopped it and not as a link whose target is missing.
// 28. A refusal about a program that printed a version this build can read
//     carries that version.
// 29. A program that exits 0 and prints the word EACCES is used, it is not
//     reported as not executable.
// 30. A refusal for a program that printed a version this build cannot
//     read carries no version.
// 31. A link whose target path goes through a file that is not a folder is
//     refused with the error that stopped it, ENOTDIR, and not as a link
//     whose target is missing.
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolResolver, installTool, toolStatuses } from "../src/toolchain/index.js";
import { checkScanners } from "../src/toolchain/preinstall.js";
import { clearSystemResolutions, folderProblem, isInside, ownerIsTrusted, ownerProblem, resolveSystemAsset, versionFits } from "../src/toolchain/system.js";
import { isSystemAsset, loadToolchain, versionDir, type Recipe, type SystemAsset } from "../src/toolchain/table.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

// The user this test runs as: the effective one, the one the program runs
// with.
const USER = process.geteuid?.() ?? process.getuid?.() ?? 0;

const saved = {
  platform: process.platform,
  arch: process.arch,
  localbase: process.env.OPENQODEX_LOCALBASE,
  home: process.env.OPENQODEX_HOME,
  path: process.env.PATH,
  getuid: process.getuid,
  geteuid: process.geteuid,
};

// The machine this test pretends to be on.
function on(os: string, arch: string): void {
  Object.defineProperty(process, "platform", { value: os, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  clearSystemResolutions();
  process.env.OPENQODEX_HOME = tempDir("oq-system-home-");
  process.env.OPENQODEX_LOCALBASE = tempDir("oq-system-base-");
  on("freebsd", "x64");
});

afterEach(() => {
  on(saved.platform, saved.arch);
  restore("OPENQODEX_LOCALBASE", saved.localbase);
  restore("OPENQODEX_HOME", saved.home);
  restore("PATH", saved.path);
  Object.defineProperty(process, "getuid", { value: saved.getuid, configurable: true });
  Object.defineProperty(process, "geteuid", { value: saved.geteuid, configurable: true });
});

// The localbase of this test.
function base(): string {
  return process.env.OPENQODEX_LOCALBASE ?? "";
}

// A program under the localbase: a shell script with the given body.
function program(body: string, name = "shellcheck", mode = 0o755): string {
  const bin = join(base(), "bin");
  mkdirSync(bin, { recursive: true, mode: 0o755 });
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${body}`);
  chmodSync(file, mode);
  return file;
}

// The path of the program that runs, the link followed. Every reason about
// the program itself names this path and not the link.
function realOf(file: string): string {
  return realpathSync(file);
}

// The first folder above the program that the trust of a folder refuses,
// walked from the folder that holds it up to the root of the file system.
// It is the folder the resolution names when it refuses.
function firstRefusedFolder(file: string): string | null {
  let current = dirname(file);
  for (;;) {
    const folder = realpathSync(current);
    if (folderProblem(statSync(folder), USER) !== null) return folder;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// The version line shellcheck prints on a FreeBSD host.
const VERSION = 'echo "version: 0.11.0"\n';

// The shellcheck recipe of the table, with its FreeBSD system asset.
function shellcheckAsset(): { recipe: Recipe; asset: SystemAsset } {
  const recipe = loadToolchain().tools.shellcheck;
  if (recipe.method !== "github-release") throw new Error("shellcheck is not a release recipe");
  const asset = recipe.assets["freebsd-x64"];
  if (asset === undefined || asset === null || !isSystemAsset(asset)) throw new Error("shellcheck has no FreeBSD system asset");
  return { recipe, asset };
}

// The reason a resolution gives when it fails.
async function reasonOf(scanner: string): Promise<string> {
  const resolution = await createToolResolver({ allowInstall: false })(scanner as never);
  if (resolution.ok) throw new Error(`${scanner} resolved, so it has no reason`);
  return resolution.reason;
}

describe("versionFits", () => {
  it("takes the pin and a newer patch, and refuses the rest (4)", () => {
    const cases: [string, string, string][] = [
      ["0.17.5", "0.17.5", "ok"],
      ["0.17.5", "0.17.9", "ok"],
      ["0.17.5", "0.17.4", "older"],
      ["0.17.5", "0.18.0", "other-series"],
      ["0.17.5", "0.16.9", "older"],
      ["0.17.5", "1.17.5", "other-series"],
      ["1.17.5", "0.17.5", "older"],
      ["0.17.5", "0.17", "invalid"],
      ["0.17.5", "0.17.5.1", "invalid"],
      ["0.17.5", "", "invalid"],
      ["0.17.5", "x.y.z", "invalid"],
    ];
    for (const [pin, found, expected] of cases) expect(versionFits(pin, found), `${pin} and ${found}`).toBe(expected);
  });
});

describe("a tool the system's package manager installs", () => {
  it("is resolved from the localbase and reports the version it found (5)", async () => {
    const file = program(VERSION);
    const resolution = await createToolResolver({ allowInstall: false })("shellcheck");
    expect(resolution).toEqual({ ok: true, tool: { path: file, version: "0.11.0", env: {} } });
  });

  it("takes a newer patch from pkg and reports that version (5)", async () => {
    program('echo "version: 0.11.3"\n');
    const resolution = await createToolResolver({ allowInstall: false })("shellcheck");
    expect(resolution).toEqual({ ok: true, tool: { path: join(base(), "bin", "shellcheck"), version: "0.11.3", env: {} } });
  });

  it("is not ready when the package is not installed (2)", async () => {
    expect(await reasonOf("shellcheck")).toBe("hs-ShellCheck is not installed: pkg install hs-ShellCheck");
  });

  it("is missing, and not refused, when the package is not installed (2)", async () => {
    const { recipe, asset } = shellcheckAsset();
    expect(await resolveSystemAsset("shellcheck", recipe, asset)).toEqual({ ok: false, kind: "missing", reason: "hs-ShellCheck is not installed: pkg install hs-ShellCheck" });
  });

  it("is not ready when the path holds a directory and not a program (2)", async () => {
    mkdirSync(join(base(), "bin", "shellcheck"), { recursive: true });
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} did not run: it is not a file`);
  });

  it("is not ready when the program cannot be run by this user (2, 25)", async () => {
    program(VERSION, "shellcheck", 0o644);
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} did not run: it is not executable`);
  });

  it("is ready when it ran and printed the words of a failed start (25, 29)", async () => {
    // The program ran and said it, so the run did not fail to start: the
    // words on the error stream are what it printed, not an error.
    const file = program('echo "EACCES" 1>&2\necho "version: 0.11.0"\n');
    const resolution = await createToolResolver({ allowInstall: false })("shellcheck");
    expect(resolution).toEqual({ ok: true, tool: { path: realOf(file), version: "0.11.0", env: {} } });
  });

  it("is not used when anyone can write it (3)", async () => {
    program(VERSION, "shellcheck", 0o775);
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} is writable by group or others`);
  });

  it("is not used when the world can write it (3)", async () => {
    program(VERSION, "shellcheck", 0o757);
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} is writable by group or others`);
  });

  it("is not used when the program belongs to another user (12)", async () => {
    const file = program(VERSION);
    if (USER === 0) {
      // As root the program belongs to root, and a program of root is
      // trusted. Give it to another user so the case is the same one.
      chownSync(file, 65534, -1);
    } else {
      // Pretend to be another user: the program then belongs to one. The
      // effective user is the one the build runs as, so it is the one that
      // changes. The real user is not read by the code, so it is not
      // changed here.
      Object.defineProperty(process, "geteuid", { value: () => USER + 1, configurable: true });
    }
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realOf(file)} is owned by another user`);
  });

  it.skipIf(USER === 0)("is not used when the build runs as another user than the one the program belongs to (20)", async () => {
    const file = program(VERSION);
    // The program belongs to the real user, and the build runs as the
    // effective one, which is another: the program is the real user's, and
    // the build must not run it.
    Object.defineProperty(process, "getuid", { value: () => USER, configurable: true });
    Object.defineProperty(process, "geteuid", { value: () => 0, configurable: true });
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realOf(file)} is owned by another user`);
  });

  it("is not used when anyone can write the folder above it (13)", async () => {
    program(VERSION);
    const bin = realpathSync(join(base(), "bin"));
    chmodSync(bin, 0o777);
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${bin} is writable by group or others`);
  });

  it("is not used when the group can write the folder above it (13)", async () => {
    program(VERSION);
    const bin = realpathSync(join(base(), "bin"));
    chmodSync(bin, 0o775);
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${bin} is writable by group or others`);
  });

  it("is not used when the folder that holds the link to it can be written to (19)", async () => {
    // The program is in another folder, and the folder that holds the link
    // to it is one another user can write to: that user can put a program of
    // their own there.
    const libexec = join(base(), "libexec");
    mkdirSync(libexec, { recursive: true, mode: 0o755 });
    const real = join(libexec, "shellcheck");
    writeFileSync(real, `#!/bin/sh\n${VERSION}`);
    chmodSync(real, 0o755);
    const bin = join(base(), "bin");
    mkdirSync(bin, { recursive: true, mode: 0o755 });
    symlinkSync(real, join(bin, "shellcheck"));
    chmodSync(bin, 0o777);
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realpathSync(bin)} is writable by group or others`);
  });

  it("is not used when the group can write the folder that holds the link to it (19)", async () => {
    // The same case with the group: the folders that hold the program are
    // trusted, and the folder that holds the link to it is not.
    const libexec = join(base(), "libexec");
    mkdirSync(libexec, { recursive: true, mode: 0o755 });
    const real = join(libexec, "shellcheck");
    writeFileSync(real, `#!/bin/sh\n${VERSION}`);
    chmodSync(real, 0o755);
    const bin = join(base(), "bin");
    mkdirSync(bin, { recursive: true, mode: 0o755 });
    symlinkSync(real, join(bin, "shellcheck"));
    chmodSync(bin, 0o775);
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realpathSync(bin)} is writable by group or others`);
  });

  it("is not used when the program a link points at belongs to another user (12, 18)", async () => {
    // The link says nothing about the program: the owner and the mode are
    // those of the program the link points at.
    const libexec = join(base(), "libexec");
    mkdirSync(libexec, { recursive: true, mode: 0o755 });
    const real = join(libexec, "shellcheck");
    writeFileSync(real, `#!/bin/sh\n${VERSION}`);
    chmodSync(real, 0o755);
    const bin = join(base(), "bin");
    mkdirSync(bin, { recursive: true, mode: 0o755 });
    symlinkSync(real, join(bin, "shellcheck"));
    if (USER === 0) {
      // As root the program belongs to root, and a program of root is
      // trusted. Give it to another user so the case is the same one.
      chownSync(real, 65534, -1);
    } else {
      // Pretend to be another user: the program then belongs to one. The
      // code reads the effective user, so the real one is not changed.
      Object.defineProperty(process, "geteuid", { value: () => USER + 1, configurable: true });
    }
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realOf(real)} is owned by another user`);
  });

  it.skipIf(USER !== 0)("is not used when the folder above it belongs to another user (14)", async () => {
    program(VERSION);
    const bin = join(base(), "bin");
    chownSync(bin, 65534, -1);
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realpathSync(bin)} is owned by another user`);
  });

  it("is not ready when the program fails (2)", async () => {
    program("exit 3\n");
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} did not run: it exited with code 3`);
  });

  it("is not ready when the program prints no version (2)", async () => {
    program("true\n");
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} printed no version this build understands`);
  });

  it("is not ready when the program prints something else (2)", async () => {
    program('echo "hello there"\n');
    expect(await reasonOf("shellcheck")).toBe(`hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} printed no version this build understands`);
  });

  it("is not waited for ever when the program hangs (9)", async () => {
    program("sleep 30\n");
    const { recipe, asset } = shellcheckAsset();
    const resolution = await resolveSystemAsset("shellcheck", recipe, asset, { timeoutMs: 400 });
    expect(resolution).toEqual({ ok: false, kind: "refused", reason: `hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} did not run: it did not finish in time` });
  });

  it("is not used when it is older than the pin (4)", async () => {
    program('echo "version: 0.10.9"\n');
    expect(await reasonOf("shellcheck")).toBe("hs-ShellCheck 0.10.9 is older than the pinned 0.11.0: pkg upgrade hs-ShellCheck");
  });

  it("is not used when it is in another series (4)", async () => {
    program('echo "version: 0.12.0"\n');
    expect(await reasonOf("shellcheck")).toBe("hs-ShellCheck 0.12.0 is outside the pinned 0.11 series (this build pins 0.11.0)");
  });

  it("is never taken from PATH (1)", async () => {
    const marker = join(tempDir("oq-decoy-"), "ran");
    const decoy = tempDir("oq-decoy-");
    writeFileSync(join(decoy, "shellcheck"), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\necho "version: 9.9.9"\n`);
    chmodSync(join(decoy, "shellcheck"), 0o755);
    process.env.PATH = `${decoy}:${saved.path ?? ""}`;
    program(VERSION);
    const resolution = await createToolResolver({ allowInstall: false })("shellcheck");
    expect(resolution).toEqual({ ok: true, tool: { path: join(base(), "bin", "shellcheck"), version: "0.11.0", env: {} } });
    expect(existsSync(marker), "the program on PATH was run").toBe(false);
  });

  it("is refused when the link points at a target that is not there (21)", async () => {
    // The entry of the program is there, and it is a link, and the program
    // it points at is not: the package is there and cannot be used.
    const bin = join(base(), "bin");
    mkdirSync(bin, { recursive: true, mode: 0o755 });
    symlinkSync(join(bin, "gone"), join(bin, "shellcheck"));
    const { recipe, asset } = shellcheckAsset();
    const resolution = await resolveSystemAsset("shellcheck", recipe, asset);
    expect(resolution).toEqual({
      ok: false,
      kind: "refused",
      reason: `hs-ShellCheck: ${join(bin, "shellcheck")} is a link whose target is missing`,
    });
  });

  it("is refused with the error that stopped it when the link points at itself (27)", async () => {
    // Two links that point at each other: the entry is there, and the target
    // can never be reached, so the error is not a target that is missing.
    const bin = join(base(), "bin");
    mkdirSync(bin, { recursive: true, mode: 0o755 });
    symlinkSync("shellcheck-b", join(bin, "shellcheck"));
    symlinkSync("shellcheck", join(bin, "shellcheck-b"));
    const { recipe, asset } = shellcheckAsset();
    const resolution = await resolveSystemAsset("shellcheck", recipe, asset);
    if (resolution.ok) throw new Error("the loop of links resolved");
    expect(resolution.kind).toBe("refused");
    expect(resolution.reason).toContain("could not be read");
    expect(resolution.reason).toContain("ELOOP");
    expect(resolution.reason).not.toContain("target is missing");
  });

  it("is refused with the error that stopped it when the target of the link goes through a file that is not a folder (31)", async () => {
    // The entry of the program is there and it is a link, and the target
    // cannot be reached because its path goes through a file that is not a
    // folder: the error is not a target that is missing.
    const bin = join(base(), "bin");
    mkdirSync(bin, { recursive: true, mode: 0o755 });
    writeFileSync(join(bin, "file"), "not a folder\n");
    symlinkSync(join(bin, "file", "child"), join(bin, "shellcheck"));
    const { recipe, asset } = shellcheckAsset();
    const resolution = await resolveSystemAsset("shellcheck", recipe, asset);
    if (resolution.ok) throw new Error("the link to a file resolved");
    expect(resolution.kind).toBe("refused");
    expect(resolution.reason).toContain("could not be read");
    expect(resolution.reason).toContain("ENOTDIR");
    expect(resolution.reason).not.toContain("target is missing");
  });

  it("is missing when the entry of the program is not there at all (21)", async () => {
    // A file where the folder of the program should be: the entry is not
    // there, so the package is not installed.
    writeFileSync(join(base(), "bin"), "not a folder\n");
    const { recipe, asset } = shellcheckAsset();
    const resolution = await resolveSystemAsset("shellcheck", recipe, asset);
    expect(resolution).toEqual({ ok: false, kind: "missing", reason: "hs-ShellCheck is not installed: pkg install hs-ShellCheck" });
  });

  it("carries the version it found in the refusal (23)", async () => {
    program('echo "version: 0.9.0"\n');
    const { recipe, asset } = shellcheckAsset();
    expect(await resolveSystemAsset("shellcheck", recipe, asset)).toEqual({
      ok: false,
      kind: "refused",
      reason: "hs-ShellCheck 0.9.0 is older than the pinned 0.11.0: pkg upgrade hs-ShellCheck",
      version: "0.9.0",
    });
  });

  it("carries the version it printed when the program failed (28)", async () => {
    // The program said which version it is and then failed: the version is
    // there, so the refusal carries it and the pin is not reported.
    program('echo "version: 0.9.0"\nexit 3\n');
    const { recipe, asset } = shellcheckAsset();
    expect(await resolveSystemAsset("shellcheck", recipe, asset)).toEqual({
      ok: false,
      kind: "refused",
      reason: `hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} did not run: it exited with code 3`,
      version: "0.9.0",
    });
  });

  it("carries the version it printed when the program did not finish in time (28)", async () => {
    program('echo "version: 0.9.0"\nsleep 30\n');
    const { recipe, asset } = shellcheckAsset();
    expect(await resolveSystemAsset("shellcheck", recipe, asset, { timeoutMs: 400 })).toEqual({
      ok: false,
      kind: "refused",
      reason: `hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} did not run: it did not finish in time`,
      version: "0.9.0",
    });
  });

  it("carries the version it printed when it is in another series (28)", async () => {
    program('echo "version: 0.12.0"\n');
    const { recipe, asset } = shellcheckAsset();
    expect(await resolveSystemAsset("shellcheck", recipe, asset)).toEqual({
      ok: false,
      kind: "refused",
      reason: "hs-ShellCheck 0.12.0 is outside the pinned 0.11 series (this build pins 0.11.0)",
      version: "0.12.0",
    });
  });

  it("carries the version it printed when the build cannot read the pin (28)", async () => {
    // The pin of the asset is not a version this build can read, so the
    // refusal is that it cannot read one, and the version the program
    // printed still travels with it.
    program('echo "version: 0.11.0"\n');
    const { recipe, asset } = shellcheckAsset();
    const badPin = { ...asset, version: "0.11" };
    expect(await resolveSystemAsset("shellcheck", recipe, badPin)).toEqual({
      ok: false,
      kind: "refused",
      reason: "hs-ShellCheck: this build cannot read a version from it",
      version: "0.11.0",
    });
  });

  it("carries no version when the program printed one this build cannot read (2)", async () => {
    // The pattern takes what the program printed, and what it printed is
    // not a version, so there is no version to report.
    program('echo "version: 0.11"\n');
    const { recipe, asset } = shellcheckAsset();
    const loose = { ...asset, system: { ...asset.system, versionPattern: "^version: (.+)$" } };
    expect(await resolveSystemAsset("shellcheck", recipe, loose)).toStrictEqual({
      ok: false,
      kind: "refused",
      reason: `hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} printed no version this build understands`,
    });
  });

  it("carries no version when the program printed one this build cannot read and failed (30)", async () => {
    // The program printed something that is not a version and then failed:
    // there is no version to report, so the refusal carries none.
    program('echo "version: 0.11"\nexit 3\n');
    const { recipe, asset } = shellcheckAsset();
    const loose = { ...asset, system: { ...asset.system, versionPattern: "^version: (.+)$" } };
    expect(await resolveSystemAsset("shellcheck", recipe, loose)).toStrictEqual({
      ok: false,
      kind: "refused",
      reason: `hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} did not run: it exited with code 3`,
    });
  });

  it("carries no version when the program printed a word this build cannot read and failed (30)", async () => {
    // The same case with the version on the error stream, and with a word
    // that is not a version at all: the refusal carries no version.
    program('echo "version: unknown" 1>&2\nexit 3\n');
    const { recipe, asset } = shellcheckAsset();
    const loose = { ...asset, system: { ...asset.system, versionPattern: "^version: (.+)$" } };
    expect(await resolveSystemAsset("shellcheck", recipe, loose)).toStrictEqual({
      ok: false,
      kind: "refused",
      reason: `hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} did not run: it exited with code 3`,
    });
  });

  it("is found through a link to the program (2)", async () => {
    const good = program(VERSION, "shellcheck-real");
    symlinkSync(join(base(), "bin", "shellcheck-real"), join(base(), "bin", "shellcheck"));
    const resolution = await createToolResolver({ allowInstall: false })("shellcheck");
    expect(resolution).toEqual({ ok: true, tool: { path: good, version: "0.11.0", env: {} } });
  });

  it("is refused when its path is not inside the localbase (2)", async () => {
    const { recipe, asset } = shellcheckAsset();
    const outside = { ...asset, system: { ...asset.system, path: "../bin/shellcheck" } };
    expect(await resolveSystemAsset("shellcheck", recipe, outside)).toEqual({ ok: false, kind: "refused", reason: "hs-ShellCheck: ../bin/shellcheck is not a path inside the localbase" });
    const absolute = { ...asset, system: { ...asset.system, path: "/usr/local/bin/shellcheck" } };
    expect(await resolveSystemAsset("shellcheck", recipe, absolute)).toEqual({ ok: false, kind: "refused", reason: "hs-ShellCheck: /usr/local/bin/shellcheck is not a path inside the localbase" });
  });

  it("is not refused for the containment when the localbase is the root of the file system (15, 26)", async () => {
    const file = program(VERSION);
    process.env.OPENQODEX_LOCALBASE = "/";
    const { recipe, asset } = shellcheckAsset();
    const under = relative("/", file);
    const rootAsset = { ...asset, system: { ...asset.system, path: under } };
    const resolution = await resolveSystemAsset("shellcheck", recipe, rootAsset);
    // The folders from the program up to the root of the file system are
    // walked, and the first one that is not trusted is the one the refusal
    // must name. The test computes that folder itself, so the case says
    // what happened and not only what did not happen.
    const refused = firstRefusedFolder(file);
    if (refused !== null) {
      if (resolution.ok) throw new Error(`the program resolved although ${refused} is not trusted`);
      expect(resolution.kind).toBe("refused");
      expect(resolution.reason).toContain(refused);
    } else {
      expect(resolution).toEqual({ ok: true, path: realpathSync(file), version: "0.11.0" });
    }
    // The program is there, so the result is never a package that is not
    // installed, and never a refusal for being outside the localbase.
    if (!resolution.ok) {
      expect(resolution.kind).not.toBe("missing");
      expect(resolution.reason).not.toContain("is not a path inside the localbase");
    }
  });

  it("is refused when this build cannot read a version from it (10)", async () => {
    program(VERSION);
    const { recipe, asset } = shellcheckAsset();
    const noGroup = { ...asset, system: { ...asset.system, versionPattern: "^version: \\d+\\.\\d+\\.\\d+$" } };
    expect(await resolveSystemAsset("shellcheck", recipe, noGroup)).toEqual({ ok: false, kind: "refused", reason: "hs-ShellCheck: this build cannot read a version from it" });
    const broken = { ...asset, system: { ...asset.system, versionPattern: "version: (" } };
    expect(await resolveSystemAsset("shellcheck", recipe, broken)).toEqual({ ok: false, kind: "refused", reason: "hs-ShellCheck: this build cannot read a version from it" });
  });
});

describe("a path inside a root folder", () => {
  it("is inside the folder when the folder is the root of the file system (15)", () => {
    expect(isInside("/", "/bin/x")).toBe(true);
    expect(isInside("/usr/local", "/usr/local-evil/bin/x")).toBe(false);
    expect(isInside("/usr/local", "/usr/local/bin/x")).toBe(true);
  });

  it("is inside the folder when it is the folder itself (15)", () => {
    expect(isInside("/usr/local", "/usr/local")).toBe(true);
    expect(isInside("/", "/")).toBe(true);
    expect(isInside("/usr/local", "/usr")).toBe(false);
  });
});

describe("the owner of a program", () => {
  it("is trusted when it is the system's own or this user's (12)", () => {
    const cases: [number, number, boolean][] = [
      [0, 1000, true],
      [1000, 1000, true],
      [1001, 1000, false],
      [0, 0, true],
      [65534, 0, false],
      [65534, 65534, true],
    ];
    for (const [uid, user, expected] of cases) expect(ownerIsTrusted(uid, user), `uid ${uid} and user ${user}`).toBe(expected);
  });
});

describe("the trust of a folder", () => {
  // A folder as the code reads it: its owner, its mode and whether it is a
  // folder.
  function folder(uid: number, mode: number, isDirectory = true): { uid: number; mode: number; isDirectory(): boolean } {
    return { uid, mode, isDirectory: () => isDirectory };
  }

  it("is trusted when it is the system's own and nobody else can write it (14)", () => {
    expect(folderProblem(folder(0, 0o755), USER)).toBe(null);
  });

  it("is trusted when it is this user's own and nobody else can write it (14)", () => {
    expect(folderProblem(folder(USER, 0o700), USER)).toBe(null);
  });

  it("is refused when it belongs to another user (14)", () => {
    expect(folderProblem(folder(USER + 1, 0o755), USER)).toBe("is owned by another user");
  });

  it("is refused when the group can write it (14)", () => {
    expect(folderProblem(folder(USER, 0o775), USER)).toBe("is writable by group or others");
  });

  it("is refused when the world can write it (14)", () => {
    expect(folderProblem(folder(USER, 0o757), USER)).toBe("is writable by group or others");
  });

  it("is refused when it is not a folder (14)", () => {
    expect(folderProblem(folder(USER, 0o755, false), USER)).toBe("is not a folder");
  });
});

describe("a program that cannot be read", () => {
  it("is missing when the folder above it is not a folder (16, 21)", async () => {
    // A file where the folder of the program should be: the entry of the
    // program is not there, so the package is not installed. The error is
    // not named, because there is nothing to read.
    writeFileSync(join(base(), "bin"), "not a folder\n");
    const reason = await reasonOf("shellcheck");
    expect(reason).toBe("hs-ShellCheck is not installed: pkg install hs-ShellCheck");
  });

  it.skipIf(USER === 0)("names the error when the folder above it cannot be entered (16)", async () => {
    const bin = join(base(), "bin");
    program(VERSION);
    chmodSync(bin, 0o000);
    let reason: string;
    try {
      reason = await reasonOf("shellcheck");
    } finally {
      chmodSync(bin, 0o755);
    }
    expect(reason).toContain("could not be read");
    expect(reason).toContain("EACCES");
    expect(reason).not.toContain("pkg install");
  });
});

describe("the trust of a folder and of a program", () => {
  // A user that is neither root nor this one: the owner of a program that
  // this build must not run.
  const OTHER = USER === 65534 ? 65533 : 65534;

  it("gives both the same phrase for the same owner and mode (24)", () => {
    // The owners and the modes are given, so the case is the same one
    // whatever user the suite runs as. The owner comes before the mode, and
    // a folder with a problem of its owner gets the phrase of that owner.
    const cases: { uid: number; user: number; mode: number; owner: string | null; phrase: string }[] = [
      { uid: USER, user: USER, mode: 0o775, owner: null, phrase: "is writable by group or others" },
      { uid: OTHER, user: USER, mode: 0o755, owner: "is owned by another user", phrase: "is owned by another user" },
      { uid: OTHER, user: USER, mode: 0o775, owner: "is owned by another user", phrase: "is owned by another user" },
    ];
    for (const { uid, user, mode, owner, phrase } of cases) {
      expect(ownerProblem(uid, user), `owner ${uid} and user ${user}`).toBe(owner);
      expect(folderProblem({ uid, mode, isDirectory: () => true }, user), `folder ${uid} ${mode.toString(8)}`).toBe(phrase);
    }
  });

  it("gives the program the phrase a folder with the same owner and mode gets (24)", async () => {
    // The fixture belongs to the user the suite runs as. As root that user
    // is root, and a program of root is trusted whatever the effective
    // user is: giving a file to another user needs a privilege this test
    // does not ask for, so the branch that shows a program of another user
    // is the branch that runs when the suite is not root. As root the
    // program is judged as it really is, and the folder of the same owner
    // and mode is trusted too.
    const cases: { mode: number; phrase: string | null }[] = [
      { mode: 0o755, phrase: USER === 0 ? null : "is owned by another user" },
      { mode: 0o775, phrase: USER === 0 ? "is writable by group or others" : "is owned by another user" },
    ];
    for (const { mode, phrase } of cases) {
      const file = program(VERSION, "shellcheck", mode);
      const info = statSync(file);
      if (USER !== 0) {
        // The build runs as another user, so the program is this user's.
        Object.defineProperty(process, "geteuid", { value: () => USER + 1, configurable: true });
      }
      const user = USER === 0 ? USER : USER + 1;
      // The folder with the owner and the mode of the program, seen by the
      // same user, gets the same phrase.
      expect(folderProblem({ uid: info.uid, mode: info.mode, isDirectory: () => true }, user), `folder ${info.uid} ${mode.toString(8)}`).toBe(phrase);
      if (phrase === null) {
        const resolution = await createToolResolver({ allowInstall: false })("shellcheck");
        expect(resolution, `program ${mode.toString(8)}`).toEqual({ ok: true, tool: { path: realOf(file), version: "0.11.0", env: {} } });
      } else {
        expect(await reasonOf("shellcheck"), `program ${mode.toString(8)}`).toBe(`hs-ShellCheck: ${realOf(file)} ${phrase}`);
      }
      Object.defineProperty(process, "geteuid", { value: saved.geteuid, configurable: true });
      clearSystemResolutions();
    }
  });
});

describe("a tool whose package is not the same on both architectures", () => {
  // zizmor: the amd64 package is newer than the arm64 one, so each
  // architecture has a pin of its own.
  it("is ready on amd64 with the version that architecture's package has (11)", async () => {
    on("freebsd", "x64");
    const file = program('echo "zizmor 1.33.1"\n', "zizmor");
    const resolution = await createToolResolver({ allowInstall: false })("zizmor");
    expect(resolution).toEqual({ ok: true, tool: { path: file, version: "1.33.1", env: {} } });
  });

  it("is not used on amd64 when it is older than that architecture's pin (11)", async () => {
    on("freebsd", "x64");
    program('echo "zizmor 1.32.0"\n', "zizmor");
    expect(await reasonOf("zizmor")).toBe("zizmor 1.32.0 is older than the pinned 1.33.1: pkg upgrade zizmor");
  });

  it("is ready on arm64 with the version that architecture's package has (11)", async () => {
    on("freebsd", "arm64");
    const file = program('echo "zizmor 1.32.0"\n', "zizmor");
    const resolution = await createToolResolver({ allowInstall: false })("zizmor");
    expect(resolution).toEqual({ ok: true, tool: { path: file, version: "1.32.0", env: {} } });
  });

  it("is not used on arm64 when it is in another series (11)", async () => {
    on("freebsd", "arm64");
    program('echo "zizmor 1.33.1"\n', "zizmor");
    expect(await reasonOf("zizmor")).toBe("zizmor 1.33.1 is outside the pinned 1.32 series (this build pins 1.32.0)");
  });
});

describe("a tool that is not a system asset", () => {
  it("is still taken from its release asset on Linux (7, 8)", async () => {
    on("linux", "x64");
    const recipe = loadToolchain().tools.shellcheck;
    const dir = versionDir(join(process.env.OPENQODEX_HOME ?? "", "tools"), "shellcheck", recipe);
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "shellcheck"), "#!/bin/sh\n");
    chmodSync(join(dir, "bin", "shellcheck"), 0o755);
    writeFileSync(join(dir, ".installed"), JSON.stringify({ version: recipe.version }));
    const resolution = await createToolResolver({ allowInstall: false })("shellcheck");
    expect(resolution).toEqual({ ok: true, tool: { path: join(dir, "bin", "shellcheck"), version: recipe.version, env: {} } });
  });

  it("is not looked for in the localbase on Linux (8)", async () => {
    on("linux", "x64");
    program(VERSION);
    const resolution = await createToolResolver({ allowInstall: false })("shellcheck");
    expect(resolution).toEqual({ ok: false, status: "not_installed", reason: "not installed (installs are off)" });
  });
});

describe("what doctor says about a system tool", () => {
  it("is ready with the version it found (5)", async () => {
    const file = program(VERSION);
    const statuses = await toolStatuses();
    expect(statuses.find((s) => s.scanner === "shellcheck")).toEqual({ scanner: "shellcheck", state: "ready", version: "0.11.0", detail: realOf(file) });
  }, 60_000);

  it("is not available when the package is not installed (2)", async () => {
    const statuses = await toolStatuses();
    expect(statuses.find((s) => s.scanner === "shellcheck")).toEqual({
      scanner: "shellcheck",
      state: "not_installed",
      version: "0.11.0",
      detail: "hs-ShellCheck is not installed: pkg install hs-ShellCheck",
    });
  }, 60_000);

  it("is unusable when the program cannot be trusted (13, 17)", async () => {
    program(VERSION);
    const bin = realpathSync(join(base(), "bin"));
    chmodSync(bin, 0o777);
    const statuses = await toolStatuses();
    expect(statuses.find((s) => s.scanner === "shellcheck")).toEqual({
      scanner: "shellcheck",
      state: "unusable",
      version: "0.11.0",
      detail: `hs-ShellCheck: ${bin} is writable by group or others`,
    });
  }, 60_000);

  it("is unusable when the program cannot be run (2, 17)", async () => {
    program("exit 3\n");
    const statuses = await toolStatuses();
    expect(statuses.find((s) => s.scanner === "shellcheck")).toEqual({
      scanner: "shellcheck",
      state: "unusable",
      version: "0.11.0",
      detail: `hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} did not run: it exited with code 3`,
    });
  }, 60_000);

  it("is unusable when the link points at a target that is not there (21)", async () => {
    const bin = join(base(), "bin");
    mkdirSync(bin, { recursive: true, mode: 0o755 });
    symlinkSync(join(bin, "gone"), join(bin, "shellcheck"));
    const statuses = await toolStatuses();
    expect(statuses.find((s) => s.scanner === "shellcheck")).toEqual({
      scanner: "shellcheck",
      state: "unusable",
      version: "0.11.0",
      detail: `hs-ShellCheck: ${join(bin, "shellcheck")} is a link whose target is missing`,
    });
  }, 60_000);

  it("is unusable with the version the program printed and not the pin (23)", async () => {
    program('echo "version: 0.9.0"\n');
    const statuses = await toolStatuses();
    expect(statuses.find((s) => s.scanner === "shellcheck")).toEqual({
      scanner: "shellcheck",
      state: "unusable",
      version: "0.9.0",
      detail: "hs-ShellCheck 0.9.0 is older than the pinned 0.11.0: pkg upgrade hs-ShellCheck",
    });
  }, 60_000);

  it("is unusable with the version the program printed when it failed (28)", async () => {
    // The program said which version it is and then failed: the doctor
    // shows that version and not the pin.
    program('echo "version: 0.9.0"\nexit 3\n');
    const statuses = await toolStatuses();
    expect(statuses.find((s) => s.scanner === "shellcheck")).toEqual({
      scanner: "shellcheck",
      state: "unusable",
      version: "0.9.0",
      detail: `hs-ShellCheck: ${realOf(join(base(), "bin", "shellcheck"))} did not run: it exited with code 3`,
    });
  }, 60_000);
});

describe("installing a system tool", () => {
  it("installs nothing and leaves the tools folder as it was (6)", async () => {
    program(VERSION);
    const root = tempDir("oq-system-tools-");
    const before = readdirSync(root);
    const tool = await installTool("shellcheck", { place: { root, cache: join(root, "cache"), owner: root } });
    expect(readdirSync(root)).toEqual(before);
    expect(tool).toEqual({ path: join(base(), "bin", "shellcheck"), version: "0.11.0", env: {} });
  });
});

describe("the preinstall check of a system tool", () => {
  // A shellcheck that answers for its version and reports the finding of the
  // check case.
  const FAKE = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "version: 0.11.0"
  exit 0
fi
echo '[{"file":"deploy.sh","line":2,"endLine":2,"column":10,"level":"warning","code":2086,"message":"Double quote to prevent globbing and word splitting."}]'
`;

  it("passes for a system tool that is there (2)", async () => {
    program(FAKE);
    const result = await checkScanners({ installRoot: tempDir("oq-system-preinstall-"), require: ["shellcheck"] });
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([{ scanner: "shellcheck", version: "0.11.0", ok: true, detail: "reported SC2086 on deploy.sh" }]);
  }, 60_000);

  it("names the plain reason when the package is not installed (2)", async () => {
    const result = await checkScanners({ installRoot: tempDir("oq-system-preinstall-"), require: ["shellcheck"] });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["shellcheck: hs-ShellCheck is not installed: pkg install hs-ShellCheck"]);
  }, 60_000);
});
