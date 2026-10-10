// Two server runs of the scanners at once, through the real binaries: each
// with its own scratch root, both reading one install root with installs
// off; and the strict check and the server's resolver on a preinstalled
// root. Run by the end-to-end config (tests/e2e/adapters.test.ts), after the
// end-to-end setup filled the install root with `doctor --install`.
//
// Ways it could fail, written before the code:
// 1. A server run writes outside its scratch root: in the system temp
//    folder (a staging copy, an owned config, a report folder), in the
//    process's HOME (a scanner's own settings or cache), in the OpenQodex
//    home (golangci's, kubeconform's or cargo-deny's cache) or in the
//    repository.
// 2. A server run writes into the install root: a Python scanner's
//    bytecode, a cache beside a tool, a lock.
// 3. The resolver reads tools from the OpenQodex home instead of the
//    install root it was given.
// 4. Two runs at once share a folder: one's cache, staging copy or temp
//    folder is the other's, so one changes what the other reads.
// A write the first three forbid is made to fail: the temp folder, HOME,
// the OpenQodex home and the repository are read-only while the runs go, so
// a scanner that writes there fails its run. The install root stays
// writable, and is compared entry by entry before and after.
// 5. On a preinstalled root, a scanner that cannot be ready (a tool that
//    does not run, a custom scanner, a name that is no scanner) passes the
//    strict check silently or takes other than one line; after a tool is
//    removed, the server's resolver installs it again, opens a connection
//    or reads it from elsewhere; or a resolver with installs on takes a
//    root other than the OpenQodex home's tools folder.
// Added after the code review of the library branch:
// 6. A symbolic link under the scratch root is followed: a cache folder
//    reached through a link is used because it is already there, so a
//    scanner writes outside the root.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "@openqodex/core";
import type { BuiltinScanner } from "@openqodex/core";
import { ADAPTERS, CHECK_CASES, IN_PROCESS, checkCase, createToolResolver, loadToolchain, preinstallScanners, runScanners } from "@openqodex/scanners";
import { adoptTempDir, removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";
// Points OPENQODEX_HOME at the end-to-end setup's home, whose tools folder
// is the install root here.
import { withLoggingProxy } from "./subprocess-support.js";

afterAll(removeTempDirs);

const offline = () => process.env.OPENQODEX_E2E_OFFLINE === "1";

// A folder for scratch roots with a short path. TFLint's plugin socket goes
// in <root>/tmp, which must be 64 characters or fewer, and a server run
// refuses to start TFLint otherwise; the test run's own temp folder can be
// longer than that (macOS's is), so these live directly under /tmp.
function shortParent(): string {
  const dir = mkdtempSync("/tmp/oq-ss-");
  adoptTempDir(dir);
  return dir;
}
const installRoot = join(process.env.OPENQODEX_HOME!, "tools");

// Every entry under `dir`, with its kind, size and modification time, and
// for a file its device and inode.
function tree(dir: string): Map<string, { what: string; id: string | null }> {
  const out = new Map<string, { what: string; id: string | null }>();
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(e.parentPath, e.name);
    const s = lstatSync(path);
    const what = s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : `file ${s.size} ${s.mtimeMs}`;
    out.set(relative(dir, path), { what, id: s.isFile() ? `${s.dev}:${s.ino}` : null });
  }
  return out;
}
const shape = (dir: string) => Object.fromEntries([...tree(dir)].map(([k, v]) => [k, v.what]));

// Read-only for a whole folder, or writable again.
function setWritable(dir: string, writable: boolean): void {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true }).map((e) => ({ path: join(e.parentPath, e.name), dir: e.isDirectory() }));
  const all = [...entries, { path: dir, dir: true }];
  // Folders last when closing, first when opening, so every entry is reachable.
  for (const e of writable ? all.reverse() : all) {
    if (lstatSync(e.path).isSymbolicLink()) continue;
    chmodSync(e.path, e.dir ? (writable ? 0o755 : 0o555) : writable ? 0o644 : 0o444);
  }
}

// One repository holding every check case's files, every line changed;
// where two cases name the same path, the first keeps it.
function plantAll(): { repo: string; paths: string[]; coverage: Map<string, Set<number>> } {
  const repo = tempDir("oq-server-repo-");
  const coverage = new Map<string, Set<number>>();
  for (const c of Object.values(CHECK_CASES)) {
    if (c.network && offline()) continue;
    for (const [name, body] of Object.entries(c.files())) {
      if (coverage.has(name)) continue;
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      writeFileSync(join(repo, name), body);
      coverage.set(name, new Set(body.split("\n").map((_, i) => i + 1)));
    }
  }
  return { repo, paths: [...coverage.keys()], coverage };
}

describe("server runs of the scanners", () => {
  it("two runs at once, each with its own scratch root and one install root, write only inside their own roots", async () => {
    // The scanners this install root can run here.
    const ready: BuiltinScanner[] = [];
    const check = createToolResolver({ allowInstall: false, installRoot });
    for (const adapter of ADAPTERS) {
      const network = checkCase(adapter.source)?.network === true;
      if (network && offline()) continue;
      if (IN_PROCESS.has(adapter.source) || (await check(adapter.source)).ok) ready.push(adapter.source);
    }
    expect(ready.length, "no scanner is installed in the end-to-end home").toBeGreaterThan(10);

    const { repo, paths, coverage } = plantAll();
    const watched = { tmp: tempDir("oq-server-tmp-"), home: tempDir("oq-server-home-"), openqodex: tempDir("oq-server-oqhome-") };
    const scratchParent = shortParent();
    const roots = [join(scratchParent, "a"), join(scratchParent, "b")];

    const before = { repo: shape(repo), install: shape(installRoot) };
    const env = { TMPDIR: process.env.TMPDIR, HOME: process.env.HOME, OPENQODEX_HOME: process.env.OPENQODEX_HOME };
    process.env.TMPDIR = watched.tmp;
    process.env.HOME = watched.home;
    process.env.OPENQODEX_HOME = watched.openqodex;
    for (const dir of [...Object.values(watched), repo]) setWritable(dir, false);
    let runs: Awaited<ReturnType<typeof runScanners>>[];
    try {
      runs = await Promise.all(
        roots.map((scratchRoot) =>
          runScanners({
            repoDir: repo,
            changedPaths: paths,
            coverage,
            config: parseConfig("").config,
            resolveTool: createToolResolver({ allowInstall: false, installRoot }),
            only: ready,
            scratchRoot,
          }),
        ),
      );
    } finally {
      for (const dir of [...Object.values(watched), repo]) setWritable(dir, true);
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    // Every scanner ran in both runs: one that tried to write where it may
    // not would have failed.
    for (const run of runs) {
      const notRan = run.scan.scanners.filter((s) => s.status !== "ran").map((s) => `${s.scanner}: ${s.status} ${s.reason ?? ""}`);
      expect(notRan).toEqual([]);
    }
    expect(runs[1]!.scan.candidates).toEqual(runs[0]!.scan.candidates);

    // Nothing written outside the scratch roots.
    for (const dir of Object.values(watched)) expect(readdirSync(dir), dir).toEqual([]);
    expect(shape(repo)).toEqual(before.repo);
    expect(shape(installRoot)).toEqual(before.install);

    // Each run wrote in its own root, and no file is in both.
    const [a, b] = roots.map((r) => tree(r));
    expect(a!.size).toBeGreaterThan(0);
    expect(b!.size).toBeGreaterThan(0);
    const ids = new Set([...a!.values()].map((v) => v.id).filter((id) => id !== null));
    expect([...b!.values()].filter((v) => v.id !== null && ids.has(v.id))).toEqual([]);
  }, 600_000);

  it("on a preinstalled root, a scanner that cannot be ready fails the strict check with one line, and the server's resolver never installs a removed tool (failure 5)", async () => {
    // A root of its own holding copies of two tools the end-to-end setup
    // installed, so the shared root is never changed.
    const table = loadToolchain();
    const root = join(tempDir("oq-server-preinstalled-"), "tools");
    for (const tool of ["actionlint", "hadolint"]) {
      mkdirSync(join(root, tool), { recursive: true });
      cpSync(join(installRoot, tool, table.tools[tool]!.version), join(root, tool, table.tools[tool]!.version), { recursive: true });
    }

    // hadolint's real binary in the copy, with its execute bit taken away:
    // the folder and its marker still say installed, but it cannot run.
    const hadolint = join(root, "hadolint", table.tools.hadolint!.version, "bin", "hadolint");
    expect(lstatSync(hadolint).isFile()).toBe(true);
    chmodSync(hadolint, 0o644);
    const strict = await countFetches(() => preinstallScanners({ installRoot: root, require: ["hadolint", "custom:mine", "no-such-scanner" as BuiltinScanner] }));
    expect(strict.result.ok).toBe(false);
    expect(strict.result.missing).toHaveLength(3);
    expect(strict.result.missing[0]).toMatch(/^hadolint: its check case did not report DL3007 on Dockerfile \(/);
    expect(strict.result.missing[1]).toMatch(/^custom:mine: /);
    expect(strict.result.missing[2]).toBe("no-such-scanner: not a built-in scanner");
    expect(strict.fetches).toBe(0);

    // actionlint removed: the resolver with installs off says so, and a
    // server run of the scanners reports it, installing nothing.
    rmSync(join(root, "actionlint"), { recursive: true });
    const before = shape(root);
    const resolve = createToolResolver({ allowInstall: false, installRoot: root });
    const { result: proxied, hosts } = await withLoggingProxy(() => countFetches(() => resolve("actionlint")));
    expect(proxied.result).toEqual({ ok: false, status: "not_installed", reason: "not installed (installs are off)" });
    expect(proxied.fetches).toBe(0);
    expect(hosts).toEqual([]);
    const repo = tempDir("oq-server-preinstalled-repo-");
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
    const scan = await countFetches(() =>
      runScanners({
        repoDir: repo,
        changedPaths: [".github/workflows/ci.yml"],
        coverage: new Map([[".github/workflows/ci.yml", new Set([1, 2, 3, 4, 5, 6])]]),
        config: parseConfig("").config,
        resolveTool: createToolResolver({ allowInstall: false, installRoot: root }),
        only: ["actionlint"],
        scratchRoot: join(tempDir("oq-server-preinstalled-scratch-"), "run"),
      }),
    );
    expect(scan.result.scan.scanners).toEqual([expect.objectContaining({ scanner: "actionlint", status: "not_installed", reason: "not installed (installs are off)" })]);
    expect(scan.fetches).toBe(0);
    expect(shape(root)).toEqual(before);

    // Installs on demand never go into a root other than the home's tools folder.
    expect(() => createToolResolver({ allowInstall: true, installRoot: root })).toThrow(/preinstallScanners/);
  }, 300_000);

  it("refuses a link under the scratch root, even on the way to a cache folder already there, and writes nothing through it (failure 6)", async () => {
    if (offline()) {
      process.stdout.write("server roots, links: skipped, kubeconform does not run with OPENQODEX_E2E_OFFLINE=1\n");
      return;
    }
    // kubeconform's schema cache for the pinned commit, already there in a
    // folder outside the root that the root's cache folder links to.
    const recipe = loadToolchain().tools.kubeconform!;
    const commit = recipe.method === "github-release" ? recipe.schemas!.commit : "";
    const outside = tempDir("oq-server-link-outside-");
    mkdirSync(join(outside, "kubeconform", commit), { recursive: true });
    const scratchRoot = join(shortParent(), "run");
    mkdirSync(scratchRoot);
    symlinkSync(outside, join(scratchRoot, "cache"));
    const repo = tempDir("oq-server-link-repo-");
    const files = checkCase("kubeconform")!.files();
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      writeFileSync(join(repo, name), body);
    }
    const result = await runScanners({
      repoDir: repo,
      changedPaths: Object.keys(files),
      coverage: new Map(Object.entries(files).map(([name, body]) => [name, new Set(body.split("\n").map((_, i) => i + 1))])),
      config: parseConfig("").config,
      resolveTool: createToolResolver({ allowInstall: false, installRoot }),
      only: ["kubeconform"],
      scratchRoot,
    });
    const status = result.scan.scanners[0]!;
    expect(status).toMatchObject({ scanner: "kubeconform", status: "failed" });
    expect(status.reason).toMatch(/is a symbolic link/);
    expect(readdirSync(join(outside, "kubeconform", commit))).toEqual([]);
  }, 300_000);
});

// Calls to the global fetch, which the installer downloads with, counted
// and passed through.
async function countFetches<T>(fn: () => Promise<T>): Promise<{ result: T; fetches: number }> {
  let fetches = 0;
  const real = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    fetches += 1;
    return real(...args);
  }) as typeof fetch;
  try {
    return { result: await fn(), fetches };
  } finally {
    globalThis.fetch = real;
  }
}
