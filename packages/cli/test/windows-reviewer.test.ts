// Starting and stopping the separate reviewer on Windows (#207), on this
// machine with the platform passed in: real files in real temporary folders,
// and a real Node script started through a real npm shim.
//
// Ways it could fail, written before the code:
//  1. On Windows the reviewer is looked for under its bare name, or must have
//     an execute bit, so `claude.cmd` or `claude.exe` is never found; or an
//     extension Windows cannot start by itself (.JS) is taken.
//  2. A .cmd shim is started without a shell, which Node refuses (EINVAL), or
//     through cmd.exe, which parses the arguments and looks for `node` in the
//     review copy first.
//  3. A timed-out reviewer on Windows is stopped through a process group,
//     which Windows does not have, so it keeps running; or taskkill is named
//     bare and found in the current folder first.
//  4. TEMP and TMP do not reach the reviewer on Windows.
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { codexEnv, findOnPath, launch, reviewerEnv, spawnGroup, windowsStop } from "@openqodex/review";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const file = (dir: string, name: string, text = "", mode = 0o644) => {
  writeFileSync(join(dir, name), text);
  chmodSync(join(dir, name), mode);
  return realpathSync(join(dir, name));
};

// The shim npm 10 writes for a package bin that is a Node script.
const npmShim = (target: string) =>
  [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
    "",
  ].join("\r\n");

describe("1. finding the reviewer on Windows", () => {
  it("tries each extension of PATHEXT that Windows can start, in its order, with no execute bit", () => {
    const a = tempDir("oq-win-path-a-");
    const b = tempDir("oq-win-path-b-");
    file(a, "claude", "#!/bin/sh\n", 0o755);
    file(a, "claude.js");
    const cmd = file(a, "claude.cmd");
    const exe = file(b, "claude.exe");
    const path = [a, b].join(";");
    expect(findOnPath("claude", [], path, "win32", ".COM;.EXE;.BAT;.CMD;.JS")).toBe(cmd);
    expect(findOnPath("claude", [], [b, a].join(";"), "win32", ".COM;.EXE;.BAT;.CMD")).toBe(exe);
    expect(findOnPath("claude", [], path, "win32", ".JS")).toBeNull();
    // No PATHEXT: Windows' own list.
    expect(findOnPath("claude", [], path, "win32", "")).toBe(cmd);
  });

  it("still skips a program inside the repository, and leaves macOS and Linux as they were", () => {
    const repo = tempDir("oq-win-repo-");
    const outside = tempDir("oq-win-out-");
    file(repo, "claude.cmd");
    const cmd = file(outside, "claude.cmd");
    expect(findOnPath("claude", [repo], [repo, outside].join(";"), "win32", ".CMD")).toBe(cmd);
    const sh = file(outside, "claude", "#!/bin/sh\n", 0o755);
    expect(findOnPath("claude", [repo], [repo, outside].join(":"), "linux", ".CMD")).toBe(sh);
  });
});

describe("2. starting an npm shim on Windows", () => {
  it("starts the Node script the shim wraps with this Node, every argument as given", async () => {
    const dir = tempDir("oq-win-shim-");
    mkdirSync(join(dir, "node_modules", "@anthropic-ai", "claude-code"), { recursive: true });
    const script = file(join(dir, "node_modules", "@anthropic-ai", "claude-code"), "cli.js", "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const shim = file(dir, "claude.cmd", npmShim("node_modules\\@anthropic-ai\\claude-code\\cli.js"));
    const args = ["--settings", JSON.stringify({ hooks: {}, disableAllHooks: true }), "a b&c|d", "100%PATH%", 'say "hi"\\'];
    expect(launch(shim, args, "win32")).toEqual([process.execPath, [script, ...args]]);
    const child = spawnGroup(shim, args, { cwd: tempDir("oq-win-snap-"), env: process.env }, "win32");
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => (out += c));
    child.stdin?.end();
    const code = await new Promise((done) => child.on("close", done));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(args);
  });

  it("starts a .exe the shim wraps as it is, and refuses a shim that names neither", () => {
    const dir = tempDir("oq-win-shim-exe-");
    const exe = join(realpathSync(dir), "node_modules", "codex", "bin", "codex.exe");
    const shim = file(dir, "codex.cmd", `@"%~dp0\\node_modules\\codex\\bin\\codex.exe"   %*\r\n`);
    expect(launch(shim, ["exec"], "win32")).toEqual([exe, ["exec"]]);
    const other = file(dir, "other.cmd", '@"%~dp0\\..\\Yarn\\bin\\other.cmd" %*\r\n');
    expect(() => launch(other, [], "win32")).toThrow(/names no program openqodex can start/);
    expect(() => launch(file(dir, "empty.bat", "@echo off\r\n"), [], "win32")).toThrow(/names no program openqodex can start/);
  });

  it("leaves every other program, and every other platform, as it was", () => {
    expect(launch("C:\\Tools\\claude.exe", ["-p"], "win32")).toEqual(["C:\\Tools\\claude.exe", ["-p"]]);
    expect(launch("/usr/local/bin/claude.cmd", ["-p"], "linux")).toEqual(["/usr/local/bin/claude.cmd", ["-p"]]);
  });
});

describe("3. stopping a reviewer on Windows", () => {
  it("runs taskkill from the system folder on the whole tree, at once", () => {
    expect(windowsStop(4242, { SystemRoot: "D:\\Win" })).toEqual(["D:\\Win\\System32\\taskkill.exe", ["/pid", "4242", "/T", "/F"]]);
    expect(windowsStop(7, { SYSTEMROOT: "C:\\Windows" })[0]).toBe("C:\\Windows\\System32\\taskkill.exe");
    // A missing or relative system folder never makes taskkill a bare name.
    expect(windowsStop(7, { SystemRoot: "Windows" })[0]).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(windowsStop(7, {})[0]).toBe("C:\\Windows\\System32\\taskkill.exe");
  });
});

describe("4. the temporary folder on Windows", () => {
  it("TEMP and TMP reach either reviewer on Windows only", () => {
    const env = { TEMP: "C:\\Users\\u\\AppData\\Local\\Temp", Tmp: "C:\\Temp", GITHUB_TOKEN: "g" };
    for (const make of [reviewerEnv, codexEnv]) {
      expect(make(env, "win32")).toMatchObject({ TEMP: env.TEMP, Tmp: env.Tmp });
      expect(make(env, "win32").GITHUB_TOKEN).toBeUndefined();
      expect(make(env, "linux").TEMP).toBeUndefined();
    }
  });
});
