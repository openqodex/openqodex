// The readers of the repository's own files: manifests, lockfiles,
// tsconfig, globs, and the text the extractor hashes. Every input comes from
// the repository (a branch, a pull request), so a crafted file must not hang
// the graph. Ways they could fail, one test each:
// 1. A pattern whose repetitions overlap backtracks on a long hostile line,
//    so one reader takes seconds or never ends: every reader must read a
//    1 MiB hostile input in about four times the CPU time of 256 KiB, each
//    run repeated until the smaller passes the noise.
// 2. A manifest or a lockfile over its byte cap is read anyway.
// 3. A linear reader stops reading what it must (the positive controls).
// 4. Stripping a trailing comma or a comment from a tsconfig changes the
//    text of a string that holds one.
// 5. A glob with many stars against a long path backtracks.
// 6. Comment stripping in the extractor's body hash is quadratic on many
//    unclosed comments.
// 7. An edge id with many separators makes `explain` backtrack.
import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/index.js";
import { discoverProjects } from "../src/discovery/projects.js";
import { matchesGlob } from "@openqodex/core";
import {
  LOCKFILE_BYTES,
  MANIFEST_BYTES,
  gemfileGems,
  goModRequires,
  goModule,
  parseJsonc,
  pnpmLinks,
  pnpmPackages,
  pyprojectDeps,
  requirementsDeps,
  setupCfgRequires,
  yarnLock,
} from "../src/discovery/manifests.js";
import { query } from "../src/query/engine.js";
import { RepoReader } from "../src/safe-fs.js";
import { cpuMs, expectLinear, expectLinearRepeated, repeatedCpuMs } from "../src/test-timing.js";
import { makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const MiB = 1024 * 1024;

// `head`, then `unit` repeated, then `tail`: `size` characters or a few more.
const shape = (head: string, unit: string, tail = "") => (size: number) => head + unit.repeat(Math.ceil((size - head.length - tail.length) / unit.length)) + tail;
const pad = (head: string, unit: string, tail = "") => shape(head, unit, tail)(MiB);

// Runs `read` on each shape at 256 KiB and at 1 MiB, the cap the build reads
// a manifest under, each run repeated until the smaller passes the noise
// (src/test-timing.ts): the CPU time grows about four times, never sixteen.
async function linear(shapes: ((size: number) => string)[], read: (text: string) => unknown): Promise<void> {
  for (const [i, make] of shapes.entries()) {
    const small = make(MiB / 4);
    const large = make(MiB);
    expect(large.length).toBeGreaterThanOrEqual(MiB - 64);
    await expectLinearRepeated(`input ${i + 1} at 256 KiB and at 1 MiB`, repeatedCpuMs(() => read(small)), repeatedCpuMs(() => read(large)));
  }
}

describe("each reader of a repository file is linear (1)", () => {
  it("pnpm-workspace.yaml", async () => {
    await linear([shape("packages:\n  - a", " ", "x"), shape("packages: ", " ", "x"), shape("packages:\n", "  - a #\n")], pnpmPackages);
  });
  it("pnpm-lock.yaml", async () => {
    await linear([shape("importers:\n  a", ": ", "x"), shape("importers:\n  .:\n    dependencies:\n      a", ":", " x"), shape("importers:\n", "\n")], pnpmLinks);
  });
  it("yarn.lock", async () => {
    await linear([shape("a@1:\n  resolved ", ":", "x"), shape("", "a@1, ", ":\n"), shape("", "\n")], yarnLock);
  });
  it("pyproject.toml", async () => {
    await linear([shape("[project]\n", "\n", "x"), shape("[project]\ndependencies = [", '"a", '), shape("[", "a.", "]"), shape("[tool.poetry.dependencies]\n", " ", "x")], pyprojectDeps);
  });
  it("setup.cfg", async () => {
    await linear([shape("[options]\ninstall_requires =\n", " a", "!"), shape("[options]\ninstall_requires =", " ", "x")], setupCfgRequires);
  });
  it("requirements.txt", async () => {
    await linear([shape("a", " ", "#"), shape("", "a ", "x"), shape("a[", "x")], requirementsDeps);
  });
  it("go.mod", async () => {
    await linear([shape("require ", "a.", " "), shape("", "\n", "x"), shape("module ", " ", "x")], (t) => [goModRequires(t), goModule(t)]);
  });
  it("Gemfile", async () => {
    await linear([shape("", "\n", "x"), shape("gem ", " ", "x"), shape("gem(", "\n")], gemfileGems);
  });
  it("tsconfig.json and jsconfig.json", async () => {
    await linear([shape("{", ", "), shape("{", " ", ","), shape('{"a": "', "/*,]", '"}'), shape("{", "/* x */,")], (t) => {
      try {
        parseJsonc(t);
      } catch {
        // a broken file is not read; it must still end quickly
      }
    });
  });
});

describe("the byte caps (2)", () => {
  it("names the caps and reads no manifest or lockfile over them", () => {
    expect(MANIFEST_BYTES).toBe(MiB);
    expect(LOCKFILE_BYTES).toBe(16 * MiB);
    const root = makeRepo({ "pnpm-workspace.yaml": "packages:\n  - packages/*\n", "packages/a/package.json": '{ "name": "a" }\n' });
    // A pnpm-workspace.yaml just over the cap is not read: no member is found.
    writeFileSync(join(root, "pnpm-workspace.yaml"), pad("packages:\n  - packages/*\n", "#", "\n") + "x".repeat(64));
    const model = discoverProjects(["pnpm-workspace.yaml", "packages/a/package.json"], new RepoReader(root));
    expect(model.members.size).toBe(0);
  });
});

describe("the readers still read their files (3)", () => {
  it("reads the workspace list in block and flow form", () => {
    expect(pnpmPackages("packages:\n  - 'packages/*' # all\n  - \"apps/*\"\n  - '!packages/old'\nother: 1\n")).toEqual(["packages/*", "apps/*", "!packages/old"]);
    expect(pnpmPackages("packages: [packages/*, 'tools/*']\n")).toEqual(["packages/*", "tools/*"]);
  });
  it("reads pnpm importers in the lockfile v6 and later form and the v5 form", () => {
    const v9 = "lockfileVersion: '9.0'\nimporters:\n\n  .:\n    devDependencies:\n      vitest:\n        specifier: ^5.0.3\n        version: 5.0.3\n\n  packages/cli:\n    dependencies:\n      '@x/core':\n        specifier: workspace:*\n        version: link:../core\npackages:\n  x: 1\n";
    expect(pnpmLinks(v9)).toEqual(new Map([["", new Map([["vitest", "published"]])], ["packages/cli", new Map([["@x/core", "workspace"]])]]));
    const v5 = "importers:\n  packages/app:\n    dependencies:\n      '@x/core': link:../core\n      left-pad: 1.3.0\n";
    expect(pnpmLinks(v5).get("packages/app")).toEqual(new Map([["@x/core", "workspace"], ["left-pad", "published"]]));
  });
  it("reads yarn.lock workspace and registry entries", () => {
    const y = yarnLock('"@x/core@workspace:packages/core":\n  version: 0.0.0-use.local\n\n"left-pad@^1.0.0", left-pad@1.3.0:\n  version "1.3.0"\n  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz"\n');
    expect([...y.workspace]).toEqual(["@x/core"]);
    expect([...y.published]).toEqual(["left-pad"]);
  });
  it("reads pyproject, setup.cfg and requirements dependencies", () => {
    const py = '[project]\nname = "x"\ndependencies = [\n  "Django>=5.0", # web\n  "requests[socks]",\n]\n[tool.poetry.dependencies]\npython = "^3.11"\nPyYAML = "^6"\n[tool.isort]\nknown = ["notadep"]\n';
    expect(pyprojectDeps(py).sort()).toEqual(["django", "pyyaml", "requests"]);
    expect(setupCfgRequires("[metadata]\nname = x\n[options]\ninstall_requires =\n    click>=8\n    attrs\npython_requires = >=3.9\n").sort()).toEqual(["attrs", "click"]);
    expect(requirementsDeps("# top\nflask==3.0 # web\n-r other.txt\n\nNumPy\n").sort()).toEqual(["flask", "numpy"]);
  });
  it("reads go.mod's module and requirements", () => {
    const mod = "module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/x/y v1.2.3\n\tgolang.org/x/net v0.1.0 // indirect\n)\nrequire github.com/z/w v0.0.1\n";
    expect(goModule(mod)).toBe("example.com/app");
    expect(goModRequires(mod)).toEqual(["github.com/x/y", "golang.org/x/net", "github.com/z/w"]);
  });
  it("reads Gemfile gems", () => {
    expect(gemfileGems("source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem(\"pg\")\n  gem 'puma' # web\n")).toEqual(["rails", "pg", "puma"]);
  });
});

describe("tsconfig text (4)", () => {
  it("drops comments and trailing commas outside strings and keeps them inside", () => {
    const text = '{\n  // a comment\n  "compilerOptions": { "paths": { "@a/*": ["src/*",], }, /* block */ "x": "a,]//b/*c*/", },\n}\n';
    expect(parseJsonc(text)).toEqual({ compilerOptions: { paths: { "@a/*": ["src/*"] }, x: "a,]//b/*c*/" } });
  });
});

describe("globs (5)", () => {
  it("matches as before and in linear time on a hostile pattern", async () => {
    expect(matchesGlob("packages/core", "packages/*")).toBe(true);
    expect(matchesGlob("packages/core/x", "packages/*")).toBe(false);
    expect(matchesGlob("a/b/c/d.ts", "a/**")).toBe(true);
    expect(matchesGlob("a/b.ts", "a/?.ts")).toBe(true);
    expect(matchesGlob("a/(b).ts", "a/(b).ts")).toBe(true);
    const path = (length: number) => "a".repeat(length);
    const glob = `${"*a".repeat(200)}b`;
    expect(matchesGlob(path(4096), glob)).toBe(false);
    expect(matchesGlob(path(4096), `${"**a".repeat(200)}b`)).toBe(false);
    const both = (length: number) => () => matchesGlob(path(length), glob) || matchesGlob(path(length), `${"**a".repeat(200)}b`);
    expectLinear("two hostile globs against paths of 1,024 and of 4,096 characters", await cpuMs(both(1024)), await cpuMs(both(4096)));
  });
});

describe("the extractor's body hash (6)", () => {
  // The comment openers sit in a string, so the parser reads the file at
  // once and only the hash would be slow (an unclosed comment in code is the
  // parser's case: caps.test.ts, case 6).
  it("hashes a definition holding many comment openers in time that grows with them", async () => {
    const openers = (n: number) => makeRepo({ "a.ts": `export function f() {\n  return \`${"/* x ".repeat(n)}\`;\n}\n`, "b.py": `def f():\n    return 1 ${"# x ".repeat(n)}\n` });
    const root = openers(100_000);
    const build = (at: string) => () => buildGraph({ repoRoot: at, store: null, maxFileBytes: 2 * MiB });
    const g = await build(root)();
    expect(g.status.filesParsed).toBe(2);
    expectLinear("a build of 25,000 and of 100,000 comment openers", await cpuMs(build(openers(25_000))), await cpuMs(build(root)));
  });
});

describe("edge ids (7)", () => {
  it("refuses a hostile edge id quickly", async () => {
    const root = makeRepo({ "a.ts": "export function f() {\n  return 1;\n}\n" });
    const graph = await buildGraph({ repoRoot: root, store: null });
    const session = { graph, generation: null, treeSha: null, builtAt: null, laterEditsKnown: false };
    const explain = (separators: number) => () => query(session, { apiVersion: 1, kind: "explain", target: { id: `calls:${"->@:1".repeat(separators)}` } });
    expect(explain(200_000)().error).not.toBeNull();
    expectLinear("explaining edge ids of 50,000 and of 200,000 separators", await cpuMs(explain(50_000)), await cpuMs(explain(200_000)));
  });
});
