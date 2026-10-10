// The toolchain installs pinned scanners into the OpenQodex home folder.
// These tests download real releases from GitHub and run the real binaries.
// They import the built package (dist) and install through the built CLI,
// because the install runs in a separate detached process that cannot load
// TypeScript; run `pnpm build` first.
//
// Ways the toolchain could fail, written before the code:
// 1. The first install of a real tool does not leave a working binary at
//    tools/<tool>/<version>/bin/<binary>.
// 2. A second resolve downloads or rewrites anything although the tool is there.
// 3. A download whose sha256 differs from the table is unpacked or installed,
//    or leaves a version folder behind that a later run takes as installed.
// 4. Two resolvers racing on the same tool install it twice or corrupt it.
// 5. With installs off, a missing tool is installed anyway or the reason is
//    not one plain line.
// 6. When the install outlives its budget, the caller blocks, or the install
//    dies with the calling process instead of finishing on its own.
// 7. An archive member such as ../escape is written outside the destination.
// 8. A home folder that cannot be written gives a stack trace or a crash
//    instead of one plain line naming the fix.
// 9. A missing developer runtime (Ruby 3.0 or newer for brakeman, whose pinned
//    gem needs it, Ruby 2.7 or newer for rubocop, Go, Cargo for cargo-deny)
//    is not named.
// 10. openqodexHome ignores OPENQODEX_HOME.
// 11. An installed launcher fails when started the way scanners are started:
//     a small environment (PATH, HOME, TMPDIR, LANG) with the tool env on top.
// 12. An archive member that is a symlink or hardlink selects bytes the
//     checksum never covered.
// 13. The developer's environment (npm_config_*, UV_*, TAR_OPTIONS,
//     GEM_SPEC_CACHE) redirects where an installer reads or writes.
// 14. Two processes both take a stale lock, or a live holder loses its lock.
// 15. The install process started is not a program that installs anything
//     (install-worker-start.test.ts covers which program it is).
// 16. A child that ignores SIGTERM hangs a probe or an install for ever.
// 17. A download that trickles data never ends, or one that never stops
//     growing fills the disk.
// 18. Every resolve starts another install process while one is running.
// 19. A relative OPENQODEX_HOME gives a relative tool path.
// 20. A taker acting on an old view of a dead holder replaces a live lock.
// 21. A worker that lost the lock, or finds the version already installed,
//     publishes over it or deletes a folder it did not create.
// 22. The install process puts a relative home somewhere the caller never looks.
// 23. The caller waits past its budget on a poll interval.
// 24. A registry install (uv, gem) installs a package its lock does not
//     name, or another version of one it does.
// 25. A lock whose pins moved, with the tool's own version unchanged,
//     reuses the tree installed from the old lock.
// 26. A gem lock line in any other shape (a path in the name, no sha256)
//     is installed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/toolchain/fetch.js";
import { publishVersion, readGemLock, readLock, takeOverStaleLock } from "../src/toolchain/install.js";
import { lockedFolder } from "../src/toolchain/table.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "index.js");
// The program each install runs as: the toolchain finds the built CLI beside
// this package, as the published package finds its own bin.
const bin = join(here, "..", "..", "cli", "dist", "bin.js");
const caller = join(here, "resolve-caller.mjs");
const table = JSON.parse(readFileSync(join(here, "..", "toolchain.json"), "utf8"));
const actionlintVersion: string = table.tools.actionlint.version;

type Toolchain = typeof import("../src/toolchain/index.js");
let tc: Toolchain;

beforeAll(async () => {
  if (!existsSync(dist) || !existsSync(bin)) throw new Error("run pnpm build before these tests");
  tc = (await import(dist)) as Toolchain;
});

const savedHome = process.env.OPENQODEX_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.OPENQODEX_HOME;
  else process.env.OPENQODEX_HOME = savedHome;
});

function freshHome(): string {
  const home = tempDir("oq-toolchain-");
  process.env.OPENQODEX_HOME = home;
  return home;
}

function actionlintBin(home: string): string {
  return join(home, "tools", "actionlint", actionlintVersion, "bin", "actionlint");
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return check();
}

describe("toolchain", () => {
  it("installs actionlint end to end, then resolves it again without downloading", async () => {
    const home = freshHome();
    const lines: string[] = [];
    const resolve = tc.createToolResolver({ allowInstall: true, installBudgetMs: null, onProgress: (l) => lines.push(l) });
    const first = await resolve("actionlint");
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    expect(first.tool.path).toBe(actionlintBin(home));
    expect(first.tool.version).toBe(actionlintVersion);
    expect(execFileSync(first.tool.path, ["--version"], { encoding: "utf8" })).toContain(actionlintVersion);
    expect(lines).toEqual([`installing actionlint ${actionlintVersion} (first run only)`]);

    const marker = join(home, "tools", "actionlint", actionlintVersion, ".installed");
    const before = statSync(marker).mtimeMs;
    const again: string[] = [];
    const second = await tc.createToolResolver({ allowInstall: true, installBudgetMs: null, onProgress: (l) => again.push(l) })("actionlint");
    expect(second).toEqual(first);
    expect(again).toEqual([]);
    expect(statSync(marker).mtimeMs).toBe(before);
    expect(readdirSync(join(home, "tools", "actionlint")).filter((n) => n.startsWith(".staging"))).toEqual([]);
  }, 60_000);

  it("refuses a download whose checksum differs and leaves no version folder", async () => {
    const home = freshHome();
    const bad = structuredClone(table);
    for (const asset of Object.values(bad.tools.actionlint.assets) as { sha256: string }[]) asset.sha256 = "0".repeat(64);
    await expect(tc.installTool("actionlint", { table: bad })).rejects.toMatchObject({ message: "checksum mismatch" });
    expect(existsSync(join(home, "tools", "actionlint", actionlintVersion))).toBe(false);
    expect(readdirSync(join(home, "tools", "actionlint")).filter((n) => !n.startsWith(".lock"))).toEqual([]);
  }, 60_000);

  it("installs once when two resolvers race", async () => {
    const home = freshHome();
    const opts = { allowInstall: true, installBudgetMs: null };
    const [a, b] = await Promise.all([tc.createToolResolver(opts)("actionlint"), tc.createToolResolver(opts)("actionlint")]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
    const log = readFileSync(join(home, "tools", "actionlint", "install.log"), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
  }, 60_000);

  it("returns installing past the budget and finishes after the caller exits", async () => {
    const home = freshHome();
    // A separate caller process: resolves with a 1 ms budget, prints the result,
    // exits. The install runs on in the built CLI.
    const started = Date.now();
    const out = execFileSync(process.execPath, [caller, "resolve", "actionlint", "1"], {
      encoding: "utf8",
      env: { ...process.env, OPENQODEX_HOME: home },
      timeout: 15_000,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(JSON.parse(out)).toEqual({
      ok: false,
      status: "installing",
      reason: "first run only, still installing; it will be included next run",
    });
    expect(await waitFor(() => existsSync(join(home, "tools", "actionlint", actionlintVersion, ".installed")), 60_000)).toBe(true);
    expect(execFileSync(actionlintBin(home), ["--version"], { encoding: "utf8" })).toContain(actionlintVersion);
  }, 90_000);

  it("gives a plain reason when the home folder cannot be written", async () => {
    const parent = tempDir("oq-readonly-");
    chmodSync(parent, 0o555);
    const home = join(parent, "home");
    process.env.OPENQODEX_HOME = home;
    const r = await tc.createToolResolver({ allowInstall: true, installBudgetMs: null })("actionlint");
    chmodSync(parent, 0o755);
    expect(r).toEqual({
      ok: false,
      status: "not_installed",
      reason: `cannot write ${home} here: run \`npx openqodex doctor --install\` in this repository from your own terminal`,
    });
  });

  it("installs bandit from its lock, exactly the packages it names, and runs it from the small scanner environment (11, 13, 24)", async () => {
    const home = freshHome();
    // An index setting in the developer's environment must not reach the installer.
    process.env.UV_INDEX_URL = "http://127.0.0.1:9/simple";
    const r = await tc.createToolResolver({ allowInstall: true, installBudgetMs: null })("bandit").finally(() => {
      delete process.env.UV_INDEX_URL;
    });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", TMPDIR: tmpdir(), LANG: "en_US.UTF-8", ...r.tool.env };
    expect(execFileSync(r.tool.path, ["--version"], { encoding: "utf8", env })).toContain(table.tools.bandit.version);
    const platform = `${process.platform}-${process.arch}`;
    const norm = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
    const pins = readFileSync(join(here, "..", "locks", `bandit-${platform}.txt`), "utf8")
      .split("\n")
      .filter((l) => /^[A-Za-z0-9]/.test(l))
      .map((l) => {
        const [name, version] = l.split(" ")[0]!.split("==");
        return `${norm(name!)}==${version}`;
      })
      .sort();
    const site = join(home, "tools", "bandit");
    const folder = readdirSync(site).find((f) => f.startsWith(`${table.tools.bandit.version}-`))!;
    const lib = join(site, folder, "lib");
    const packages = readdirSync(join(lib, readdirSync(lib)[0]!, "site-packages"))
      .filter((f) => f.endsWith(".dist-info"))
      .map((f) => {
        const [name, version] = f.slice(0, -".dist-info".length).split("-");
        return `${norm(name!)}==${version}`;
      })
      .sort();
    expect(packages.map((p) => p.split("==")[0])).toEqual(pins.map((p) => p.split("==")[0]));
    expect(packages).toEqual(pins);
  }, 300_000);

  it("names a registry install's folder for its lock, so moved pins install afresh (25)", () => {
    expect(lockedFolder("1.9.4", "bandit==1.9.4 --hash=sha256:aa\n")).toMatch(/^1\.9\.4-[0-9a-f]{12}$/);
    expect(lockedFolder("1.9.4", "bandit==1.9.4 --hash=sha256:aa\n")).not.toBe(lockedFolder("1.9.4", "bandit==1.9.4 --hash=sha256:bb\n"));
  });

  it("refuses a gem lock line in any other shape (26)", () => {
    const dir = tempDir("oq-gemlock-");
    const good = `# note\nbrakeman 6.2.1 sha256:${"a".repeat(64)}\n`;
    writeFileSync(join(dir, "good.txt"), good);
    expect(readGemLock(join(dir, "good.txt"))).toEqual([{ name: "brakeman", version: "6.2.1", sha256: "a".repeat(64) }]);
    for (const bad of [`../x 1.0 sha256:${"a".repeat(64)}`, "brakeman 6.2.1", `brakeman 6.2.1 md5:${"a".repeat(32)}`]) {
      writeFileSync(join(dir, "bad.txt"), `${bad}\n`);
      expect(() => readGemLock(join(dir, "bad.txt")), bad).toThrow(/cannot read the lock line/);
    }
  });

  it("takes over a lock whose holder is dead", async () => {
    const home = freshHome();
    const dead = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    mkdirSync(join(home, "tools", "actionlint"), { recursive: true });
    writeFileSync(join(home, "tools", "actionlint", ".lock"), `${dead} deadtoken\n`);
    const r = await tc.createToolResolver({ allowInstall: true, installBudgetMs: 60_000 })("actionlint");
    expect(r).toMatchObject({ ok: true });
  }, 90_000);

  it("waits on a live lock without starting another install", async () => {
    const home = freshHome();
    const lock = join(home, "tools", "actionlint", ".lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, `${process.pid} livetoken\n`);
    const r = await tc.createToolResolver({ allowInstall: true, installBudgetMs: 1500 })("actionlint");
    expect(r).toMatchObject({ status: "installing" });
    // The holder (this test) lets go without installing. A second install
    // process, had one been started, would now install.
    rmSync(lock);
    await new Promise((done) => setTimeout(done, 6000));
    expect(existsSync(join(home, "tools", "actionlint", actionlintVersion))).toBe(false);
  }, 30_000);

  it("a takeover acting on an old view of a dead holder leaves the new holder's lock in place", () => {
    const home = freshHome();
    const dir = join(home, "tools", "actionlint");
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, ".lock");
    const dead = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    writeFileSync(lock, `${dead} oldtoken\n`);
    const observed = readLock(lock);
    // A and B both saw the dead holder; A takes over first.
    writeFileSync(join(dir, "a"), `${process.pid} tokenA\n`);
    expect(takeOverStaleLock(lock, observed, join(dir, "a"), "tokenA")).toBe(true);
    writeFileSync(join(dir, "b"), `${process.pid} tokenB\n`);
    expect(takeOverStaleLock(lock, observed, join(dir, "b"), "tokenB")).toBe(false);
    expect(readLock(lock)?.token).toBe("tokenA");
  });

  it("a worker that lost the lock publishes nothing and deletes only its own folder", () => {
    const home = freshHome();
    const dir = join(home, "tools", "actionlint");
    const other = join(dir, ".staging-other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(dir, ".lock"), `${process.pid} someoneelse\n`);
    const built = builtVersion(join(dir, ".staging-mine", "version"), "mine");
    expect(publishVersion(join(home, "tools"), "actionlint", table.tools.actionlint, built, "mytoken", "move")).toBe("lost_lock");
    expect(existsSync(join(dir, actionlintVersion))).toBe(false);
    expect(existsSync(built)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("publishing over a version another worker already installed keeps theirs", () => {
    const home = freshHome();
    const dir = join(home, "tools", "actionlint");
    builtVersion(join(dir, actionlintVersion), "theirs");
    writeFileSync(join(dir, ".lock"), `${process.pid} mytoken\n`);
    const built = builtVersion(join(dir, ".staging-mine", "version"), "mine");
    expect(publishVersion(join(home, "tools"), "actionlint", table.tools.actionlint, built, "mytoken", "move")).toBe("already_installed");
    expect(readFileSync(actionlintBin(home), "utf8")).toBe("theirs");
    expect(existsSync(built)).toBe(false);
  });

  it("a relative OPENQODEX_HOME installs where the caller looks", () => {
    const cwd = realpathSync(tempDir("oq-relinstall-"));
    const out = execFileSync(process.execPath, [caller, "resolve", "actionlint", "null"], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, OPENQODEX_HOME: "rel-home" },
      timeout: 60_000,
    });
    const r = JSON.parse(out);
    expect(r.ok).toBe(true);
    expect(r.tool.path).toBe(join(cwd, "rel-home", "tools", "actionlint", actionlintVersion, "bin", "actionlint"));
    expect(existsSync(r.tool.path)).toBe(true);
  }, 90_000);

  it("a 50 ms budget against a live lock returns at its deadline, not after a full poll interval", async () => {
    const home = freshHome();
    mkdirSync(join(home, "tools", "actionlint"), { recursive: true });
    writeFileSync(join(home, "tools", "actionlint", ".lock"), `${process.pid} livetoken\n`);
    const started = Date.now();
    const r = await tc.createToolResolver({ allowInstall: true, installBudgetMs: 50 })("actionlint");
    expect(r).toMatchObject({ status: "installing" });
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("names the missing runtime instead of installing", async () => {
    freshHome();
    // An empty PATH has neither Ruby nor Go; the caller is a separate process
    // so this process keeps its own PATH.
    const caller = `
      const tc = await import(${JSON.stringify(dist)});
      const resolve = tc.createToolResolver({ allowInstall: true, installBudgetMs: null });
      process.stdout.write(JSON.stringify([await resolve("brakeman"), await resolve("rubocop"), await resolve("golangci"), await resolve("cargo-deny")]));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", caller], {
      encoding: "utf8",
      env: { ...process.env, PATH: "/nonexistent" },
    });
    expect(JSON.parse(out)).toEqual([
      { ok: false, status: "not_installed", reason: "needs Ruby 3.0 or newer" },
      { ok: false, status: "not_installed", reason: "needs Ruby 2.7 or newer" },
      { ok: false, status: "not_installed", reason: "needs Go" },
      { ok: false, status: "not_installed", reason: "needs Cargo (Rust)" },
    ]);
  });
});

describe("downloadVerified and extractArchive", () => {
  it("refuses an archive member that escapes the destination", async () => {
    const dir = tempDir("oq-tar-");
    const archive = join(dir, "evil.tar.gz");
    writeFileSync(archive, gzipSync(tarOf([["ok.txt", "fine\n"], ["../escape.txt", "outside\n"]])));
    const dest = join(dir, "out");
    mkdirSync(dest);
    await expect(tc.extractArchive(archive, "tar.gz", dest)).rejects.toThrow(/escapes/);
    expect(existsSync(join(dir, "escape.txt"))).toBe(false);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("refuses symlink and hardlink members", async () => {
    const dir = tempDir("oq-tar-");
    const payload = join(dir, "payload");
    writeFileSync(payload, "#!/bin/sh\necho payload\n", { mode: 0o755 });
    for (const [type, link] of [["2", payload], ["1", payload]] as const) {
      const archive = join(dir, `link${type}.tar.gz`);
      writeFileSync(archive, gzipSync(tarOf([["gitleaks", "", type, link]])));
      const dest = mkdtempSync(join(dir, "out-"));
      await expect(tc.extractArchive(archive, "tar.gz", dest)).rejects.toThrow(/link/);
      expect(readdirSync(dest)).toEqual([]);
    }
  });

  it("returns the sha256 of what it downloaded and refuses a wrong one", async () => {
    const dir = tempDir("oq-dl-");
    const asset = table.tools.actionlint.assets["linux-arm64"];
    const got = await tc.downloadVerified(asset.url, null, join(dir, "a"));
    expect(got.sha256).toBe(asset.sha256);
    expect(createHash("sha256").update(readFileSync(join(dir, "a"))).digest("hex")).toBe(asset.sha256);
    await expect(tc.downloadVerified(asset.url, "f".repeat(64), join(dir, "b"))).rejects.toThrow("checksum mismatch");
    expect(existsSync(join(dir, "b"))).toBe(false);
  }, 60_000);

  it("stops a download that trickles past its deadline or grows past its cap", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200);
      if (req.url === "/big") {
        res.end(Buffer.alloc(4096));
        return;
      }
      const timer = setInterval(() => res.write("x"), 100);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = tempDir("oq-dl-");
    try {
      const started = Date.now();
      await expect(tc.downloadVerified(`${base}/slow`, null, join(dir, "a"), { deadlineMs: 1000 })).rejects.toThrow(/download failed/);
      expect(Date.now() - started).toBeLessThan(5000);
      await expect(tc.downloadVerified(`${base}/big`, null, join(dir, "b"), { maxBytes: 1000 })).rejects.toThrow(/download failed/);
      expect(existsSync(join(dir, "b"))).toBe(false);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 20_000);

  it("hard-kills a child that ignores SIGTERM at its deadline", async () => {
    const started = Date.now();
    const out = await run(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 500 });
    expect(out.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);
});

// A finished version folder as a worker leaves it before publishing.
function builtVersion(dir: string, content: string): string {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "actionlint"), content);
  writeFileSync(join(dir, ".installed"), "{}\n");
  return dir;
}

// A minimal ustar archive, written by hand so a member can carry ../ in its
// name or be a link (type "2" symlink, "1" hardlink) to any path.
function tarOf(files: (readonly [string, string] | readonly [string, string, string, string])[]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text, type = "0", link = ""] of files) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(type, 156);
    header.write(link, 157, 100, "utf8");
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
