// Where a scanner run writes. Every folder a run makes or fills is one of
// these, in one of two shapes:
//
//   the laptop: caches kept between runs under the OpenQodex home
//     (<home>/cache/golangci, kubeconform, cargo-deny), and temporary
//     folders (staging copies, owned configs, report folders) in the system
//     temp folder, each removed after use. Scanners get the developer's
//     HOME, TMPDIR, Go module cache and Cargo home.
//   a scratch root, for a server run: everything under the one folder the
//     caller names. Caches go in <root>/cache, temporary folders in
//     <root>/tmp, and every scanner process gets HOME <root>/home and
//     TMPDIR <root>/tmp, so a tool that keeps its own settings or caches
//     keeps them there. Python scanners write no bytecode beside their code
//     and Go keeps its build cache in <root>/cache/go-build, so the install
//     root is only read. A Go tool gets a module cache and a GOPATH of the
//     run's own, filled from the preinstalled module cache read as files (a
//     file proxy; Go never writes there), and a Cargo tool a Cargo home of
//     the run's own (cargo-deny copies into it what it needs from the
//     preinstalled one). Every folder under the root is made, or checked
//     when it is already there, through a guard that refuses a symbolic
//     link anywhere under the root. Two runs with two roots share no folder.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Guard, homeGuard } from "@openqodex/core";
import { openqodexHome } from "./toolchain/table.js";

export type Scratch = {
  // True for the laptop's places, false for a scratch root.
  laptop: boolean;
  // Caches live in <root>/cache.
  root: string;
  // The writer that refuses a link: under the root for a scratch root,
  // under the OpenQodex home on the laptop.
  guard(): Guard;
  // A cache folder, <root>/cache/<names>: made through the guard, or, when
  // it is already there, checked through it, so a link on the way is
  // refused either way. Its path.
  cache(...names: string[]): string;
  // Where temporary folders are made.
  temp: string;
  // Variables every scanner process gets on top of its own.
  env: Record<string, string>;
  // The environment a resolved tool runs with: its own on the laptop; on a
  // scratch root, its own with the scratch's variables on top, and a Go or
  // Cargo tool's caches moved into the root.
  toolEnv(env: Record<string, string>): Record<string, string>;
};

// The laptop's places, read when a run starts.
export function laptopScratch(): Scratch {
  const home = openqodexHome();
  let guard: Guard | undefined;
  const guarded = () => (guard ??= homeGuard(home, true));
  return {
    laptop: true,
    root: home,
    guard: guarded,
    cache: (...names) => made(guarded(), join(home, "cache", ...names)),
    temp: tmpdir(),
    env: {},
    toolEnv: (env) => env,
  };
}

// A run's own places under `root`, made now, readable by this user only.
// Throws when one of them is reached through a symbolic link.
export function scratchAt(root: string): Scratch {
  const base = resolve(root);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const guard = new Guard({ repoRoot: null, gitFolders: [], roots: [base], noLinks: true });
  const temp = made(guard, join(base, "tmp"));
  const home = made(guard, join(base, "home"));
  const cache = (...names: string[]) => made(guard, join(base, "cache", ...names));
  const env = { HOME: home, TMPDIR: temp, GOCACHE: join(base, "cache", "go-build"), PYTHONDONTWRITEBYTECODE: "1" };
  return {
    laptop: false,
    root: base,
    guard: () => guard,
    cache,
    temp,
    env,
    toolEnv(own) {
      const out: Record<string, string> = { ...own, ...env };
      // A tool that runs Go (the Go probe names its module cache).
      if (own.GOMODCACHE !== undefined || own.GOPATH !== undefined) {
        out.GOCACHE = cache("go-build");
        out.GOPATH = cache("go-path");
        out.GOMODCACHE = cache("go-mod");
        // Modules the run's own cache lacks are read from the preinstalled
        // module cache's download folder as a file proxy: read only, and
        // nothing goes to the network. Without one, the proxy stays off.
        if (own.GOMODCACHE) out.GOPROXY = pathToFileURL(join(own.GOMODCACHE, "cache", "download")).href;
        // No checksum database lookup: a module go.sum does not name fails.
        out.GOSUMDB = "off";
        // Go makes the module cache read-only by default; the run's own must
        // go when the run does.
        out.GOFLAGS = "-modcacherw";
      }
      // A tool that runs Cargo (the Cargo probe names it).
      if (own.CARGO !== undefined) out.CARGO_HOME = cache("cargo-home");
      return out;
    },
  };
}

// `dir` made through `guard`, or, when it is already there (made by an
// earlier run, or by another run just now), checked through it the same
// way: a link on the way is refused, and so is a name that is not a folder.
// Its path.
function made(guard: Guard, dir: string): string {
  try {
    guard.makeFolder(dir);
  } catch (error) {
    // The walk to a name inside it refuses a link and a non-folder on the
    // way; one name left to make means the folder itself is there.
    if (guard.check(join(dir, ".openqodex-folder")).pending.length !== 1) throw error;
  }
  return dir;
}
