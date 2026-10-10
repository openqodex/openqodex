// Where a server run of the scanners writes: its scratch root (scratch.ts),
// and what it hands a Go or a Cargo tool. No scanner runs here; the folders
// and the environment a run would use are checked directly.
//
// Ways it could fail, written before the code:
// 1. A scratch root whose tmp or home folder is a symbolic link is used, so
//    the run's temporary folders or the scanners' HOME land outside it.
// 2. A cache folder under the scratch root is used without the no-links
//    check because it is already there: a cache folder reached through a
//    link (the cache folder itself a link) is written outside the root.
// 3. A server run hands a Go tool a module cache or a GOPATH outside its
//    scratch root, or a module proxy other than the preinstalled module
//    cache read as files; or the laptop's tool environment changes.
// 4. A server run hands a Cargo tool a Cargo home outside its scratch root.
import { mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { laptopScratch, scratchAt } from "../src/scratch.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

describe("a server run's scratch root", () => {
  it("1. refuses a tmp or home folder that is a link, and writes nothing through it", () => {
    for (const name of ["tmp", "home"]) {
      const outside = tempDir("oq-scratch-outside-");
      const root = tempDir("oq-scratch-root-");
      symlinkSync(outside, join(root, name));
      expect(() => scratchAt(root), name).toThrow(/is a symbolic link/);
      expect(readdirSync(outside), name).toEqual([]);
    }
  });

  it("2. refuses a cache folder reached through a link, even one already there", () => {
    const outside = tempDir("oq-scratch-cache-outside-");
    mkdirSync(join(outside, "kubeconform", "abc"), { recursive: true });
    const root = tempDir("oq-scratch-cache-root-");
    const scratch = scratchAt(root);
    symlinkSync(outside, join(root, "cache"));
    expect(() => scratch.cache("kubeconform", "abc")).toThrow(/is a symbolic link/);
    expect(() => scratch.cache("golangci", "new")).toThrow(/is a symbolic link/);
    expect(readdirSync(outside)).toEqual(["kubeconform"]);
    expect(readdirSync(join(outside, "kubeconform", "abc"))).toEqual([]);
  });
});

describe("what a server run hands a Go or a Cargo tool", () => {
  // The environment the Go probe gives a tool: the developer's module
  // cache, GOPATH and build cache, the proxy off.
  const preinstalled = tempDir("oq-scratch-gomod-");
  const goTool = { GOTOOLCHAIN: "local", GOPROXY: "off", PATH: "/usr/local/go/bin", GOPATH: "/home/dev/go", GOMODCACHE: preinstalled, GOCACHE: "/home/dev/.cache/go-build" };
  const cargoTool = { CARGO: "/opt/rust/bin/cargo", RUSTC: "/opt/rust/bin/rustc", CARGO_HOME: "/home/dev/.cargo", CARGO_NET_OFFLINE: "true", PATH: "/opt/rust/bin" };

  it("3. a Go tool's module cache, GOPATH and build cache are the run's own, the preinstalled modules read through a file proxy; the laptop's are unchanged", () => {
    const root = tempDir("oq-scratch-go-");
    const env = scratchAt(root).toolEnv(goTool);
    for (const key of ["GOPATH", "GOMODCACHE", "GOCACHE", "HOME", "TMPDIR"]) expect(env[key]!.startsWith(`${root}/`), key).toBe(true);
    expect(env.GOPROXY).toBe(pathToFileURL(join(preinstalled, "cache", "download")).href);
    expect(env.GOSUMDB).toBe("off");
    expect(env.GOFLAGS).toBe("-modcacherw");
    expect(env.GOTOOLCHAIN).toBe("local");
    expect(laptopScratch().toolEnv(goTool)).toEqual(goTool);
  });

  it("4. a Cargo tool's Cargo home is the run's own; the laptop's is unchanged", () => {
    const root = tempDir("oq-scratch-cargo-");
    const env = scratchAt(root).toolEnv(cargoTool);
    expect(env.CARGO_HOME!.startsWith(`${root}/`)).toBe(true);
    expect(env.CARGO).toBe(cargoTool.CARGO);
    expect(laptopScratch().toolEnv(cargoTool)).toEqual(cargoTool);
  });
});
