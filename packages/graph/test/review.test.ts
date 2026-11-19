// Failures found in review, each a wrong "certain" edge or a way a hostile
// repo could steer the build. One test per failure, on a real repo:
// 1. A cache folder the repo ships as a link sends writes and deletions outside the repo.
// 2. A cache entry the repo ships (tracked by git), or one with a broken shape, is trusted.
// 3. A tsconfig.json that is a link to a file outside the repo is read.
// 4. A parameter or local named like a definition does not hide it; a nested
//    definition is found from a scope that cannot see it.
// 5. A private top-level definition wins over the export a barrel re-exports.
// 6. A static method and an instance method of one name are confused.
// 7. A reassigned local keeps the receiver type of its first value.
// 8. Python `import pkg.a as pkg` binds `pkg` to the package instead of pkg.a.
// 9. A Go external test package (`package x_test`) is merged into package x.
// 10. A function assigned inside a function has no symbol; its calls go to the outer one.
// 11. A changed file left out by the size cap reports all its symbols as removed.
// 12. Base versions are parsed past the file cap without saying so.
// 13. A recursive call site is dropped from the graph.
// 14. A name bound by destructuring (`const { a } = x`, `[a] = x`, a
//     parameter `{ a }`) does not hide a definition of the same name, so a
//     call to it gets a certain edge to that definition.
// 15. A name an import binds and the same scope then assigns (`f = lambda: 0`)
//     still links to the import.
// 16. A function assigned with `var` inside a block is visible only in the
//     block, so a call to it after the block links to the module's function.
// 17. A destructuring assignment (`({ f } = deps)`, `[f] = list`, Python
//     `f, other = pair` and `for f, other in pairs`) is not read as an
//     assignment, so a call to the name links to an import or a definition
//     the assignment replaced.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact, openStore } from "../src/index.js";
import { at, callSites, commitAll, git, makeHome, makeRepo, symbol, writeFiles } from "./helpers.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const home = makeHome();
function repo(files: Record<string, string>): string {
  const root = makeRepo(files);
  return root;
}
const cacheOf = (root: string) => join(root, ".openqodex", "graph");
// The repo's graph folder when it may be used, else none: a refused folder is never read or written.
const build = async (root: string, extra: Partial<Parameters<typeof buildGraph>[0]> = {}) => {
  const opened = await openStore(root, { home });
  return buildGraph({ repoRoot: root, store: opened.ok ? opened.store : null, ...extra });
};
const factsFiles = (root: string): string[] => {
  const dir = join(cacheOf(root), "facts");
  return readdirSync(dir).flatMap((sub) => readdirSync(join(dir, sub)).map((f) => join(dir, sub, f)));
};

describe("a hostile repo", () => {
  it("never writes or deletes through a cache folder that is a link (1)", async () => {
    const root = repo({ "a.ts": "export function a() {}\n" });
    const outside = tempDir("oq-outside-");
    const victim = join(outside, `${"a".repeat(40)}.json`);
    writeFileSync(victim, "keep");
    mkdirSync(join(root, ".openqodex"));
    symlinkSync(outside, cacheOf(root));
    const g = await build(root);
    expect(g.status.filesParsed).toBe(1);
    expect(readdirSync(outside)).toEqual([`${"a".repeat(40)}.json`]);
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });

  it("ignores cache entries the repo tracks, and reparses an entry whose shape is broken (2)", async () => {
    const files = { "a.ts": "export function a() {}\n", "b.ts": 'import { a } from "./a";\nexport function b() {\n  a();\n}\n' };
    const root = repo(files);
    await build(root);
    // Break every entry: valid JSON, a missing field.
    for (const e of factsFiles(root)) {
      const entry = JSON.parse(readFileSync(e, "utf8")) as { facts: Record<string, unknown> };
      delete entry.facts.imports;
      writeFileSync(e, JSON.stringify(entry));
    }
    // Forced fresh: the tree is unchanged, and an unforced build would load the kept index, not the facts.
    const repaired = await build(root, { mode: "fresh" });
    expect(repaired.status.parses).toBe(2);
    expect(callSites(repaired, symbol(repaired, "a.ts", "a"))).toEqual(["b.ts:3"]);

    // Forge a caller into an entry and commit the cache folder: it must not be read.
    for (const e of factsFiles(root)) {
      const entry = JSON.parse(readFileSync(e, "utf8")) as { facts: { calls: unknown[] } };
      entry.facts.calls = [];
      writeFileSync(e, JSON.stringify(entry));
    }
    git(root, "add", "-f", ".openqodex/graph");
    const forged = await build(root);
    expect(forged.status.cacheHits).toBe(0);
    expect(callSites(forged, symbol(forged, "a.ts", "a"))).toEqual(["b.ts:3"]);
  });

  it("does not read a tsconfig.json that links outside the repo (3)", async () => {
    const outside = tempDir("oq-outside-");
    writeFileSync(join(outside, "tsconfig.json"), '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/*"] } } }');
    const root = repo({ "src/a.ts": "export function a() {}\n", "src/b.ts": 'import { a } from "@lib/a";\nexport const b = () => a();\n' });
    symlinkSync(join(outside, "tsconfig.json"), join(root, "tsconfig.json"));
    const g = await build(root);
    expect(callSites(g, symbol(g, "src/a.ts", "a"))).toEqual([]);
  });
});

describe("certain edges", () => {
  it("lets a parameter or local hide a definition of the same name, and keeps nested definitions in their scope (4)", async () => {
    const files = {
      "a.ts": [
        "export function target() {}",
        "export function viaParam(target: () => void) {",
        "  target(); // PARAM",
        "}",
        "export function viaLocal() {",
        "  const target = () => 1;",
        "  return target(); // LOCAL",
        "}",
        "export function outer() {",
        "  function helper() {}",
        "  helper(); // NESTED",
        "}",
        "export function sibling() {",
        "  helper(); // SIBLING",
        "}",
        "target(); // TOP",
      ].join("\n"),
      "b.py": ["def target():", "    pass", "", "def use(target):", "    target()  # PYPARAM", "", "def own():", "    target()  # PYTOP"].join("\n"),
      "c.go": ["package c", "", "func Target() {}", "", "func Use(Target func()) {", "\tTarget() // GOPARAM", "}", "", "func Own() {", "\tTarget() // GOTOP", "}"].join("\n"),
    };
    const g = await build(repo(files));
    expect(callSites(g, symbol(g, "a.ts", "target"))).toEqual([at(files, "a.ts", "TOP")]);
    expect(callSites(g, symbol(g, "a.ts", "helper", "outer"))).toEqual([at(files, "a.ts", "NESTED")]);
    expect(callSites(g, symbol(g, "b.py", "target"))).toEqual([at(files, "b.py", "PYTOP")]);
    expect(callSites(g, symbol(g, "c.go", "Target"))).toEqual([at(files, "c.go", "GOTOP")]);
  });

  it("lets a name bound by destructuring, in a declaration or a parameter, hide a definition of the same name (14)", async () => {
    const files = {
      "a.ts": [
        "export function target() {}",
        "export function viaObject(deps: { target: () => void }) {",
        "  const { target } = deps;",
        "  target(); // OBJECT",
        "}",
        "export function viaRenamed(deps: { run: () => void }) {",
        "  const { run: target } = deps;",
        "  target(); // RENAMED",
        "}",
        "export function viaArray(list: (() => void)[]) {",
        "  const [target] = list;",
        "  target(); // ARRAY",
        "}",
        "export function viaParam({ target }: { target: () => void }) {",
        "  target(); // PARAM",
        "}",
        "export function own() {",
        "  target(); // TOP",
        "}",
      ].join("\n"),
    };
    const g = await build(repo(files));
    expect(callSites(g, symbol(g, "a.ts", "target"))).toEqual([at(files, "a.ts", "TOP")]);
    expect(g.misses).toEqual([]);
  });

  it("drops an import as evidence once the same scope assigns the name (15)", async () => {
    const files = {
      "b.py": "def f():\n    return 1\n",
      "a.py": "def run():\n    from .b import f\n    f = lambda: 0\n    return f()  # REASSIGNED\n",
      "b.ts": "export function f(): number {\n  return 1;\n}\n",
      "a.ts": 'export async function run(): Promise<number> {\n  let { f } = await import("./b.js");\n  f = () => 0;\n  return f(); // REASSIGNED\n}\n',
    };
    const g = await build(repo(files));
    expect(callSites(g, symbol(g, "b.py", "f"))).toEqual([]);
    expect(callSites(g, symbol(g, "b.ts", "f"))).toEqual([]);
  });

  it("keeps a function assigned with var inside a block visible in its whole function (16)", async () => {
    const files = {
      "a.ts": "export function f(): number {\n  return 1;\n}\n\nexport function run(): number {\n  {\n    var f = () => 2;\n  }\n  return f(); // VAR\n}\n",
    };
    const g = await build(repo(files));
    expect(callSites(g, symbol(g, "a.ts", "f"))).toEqual([]);
    expect(callSites(g, symbol(g, "a.ts", "f", "run"))).toEqual([at(files, "a.ts", "VAR")]);
  });

  it("reads a destructuring assignment as an assignment to each name it binds (17)", async () => {
    const files = {
      "b.ts": "export function f(): number {\n  return 1;\n}\n",
      "a.ts": [
        "export async function viaObject(deps: { f: () => number }): Promise<number> {",
        '  let { f } = await import("./b.js");',
        "  ({ f } = deps);",
        "  return f(); // OBJECT",
        "}",
        "",
        "export async function viaArray(list: (() => number)[]): Promise<number> {",
        '  let { f } = await import("./b.js");',
        "  [f] = list;",
        "  return f(); // ARRAY",
        "}",
        "",
      ].join("\n"),
      "b.py": "def f():\n    return 1\n",
      "a.py": "def target():\n    return 1\n\n\ndef unpack(pair):\n    from .b import f\n    f, other = pair\n    return f()  # PYIMPORT\n\n\ndef shadow(pair):\n    target, other = pair\n    return target()  # PYUNPACK\n\n\ndef loop(pairs):\n    for target, other in pairs:\n        target()  # PYFOR\n",
    };
    const g = await build(repo(files));
    expect(callSites(g, symbol(g, "b.ts", "f"))).toEqual([]);
    expect(callSites(g, symbol(g, "b.py", "f"))).toEqual([]);
    expect(callSites(g, symbol(g, "a.py", "target"))).toEqual([]);
  });

  it("resolves an import through the export table, never to a private definition of the same name (5)", async () => {
    const files = {
      "actual.ts": "export function target() {}\n",
      "barrel.ts": 'function target() {}\nexport { target } from "./actual";\nexport function other() {\n  target();\n}\n',
      "use.ts": 'import { target } from "./barrel";\ntarget(); // USE\n',
      "cjs.js": "function hidden() {}\nfunction shown() {}\nmodule.exports = { shown };\n",
      "usecjs.js": 'const { hidden, shown } = require("./cjs");\nhidden(); // HIDDEN\nshown(); // SHOWN\n',
    };
    const g = await build(repo(files));
    expect(callSites(g, symbol(g, "actual.ts", "target"))).toEqual([at(files, "use.ts", "USE")]);
    expect(callSites(g, symbol(g, "barrel.ts", "target"))).toEqual(["barrel.ts:4"]);
    expect(callSites(g, symbol(g, "cjs.js", "shown"))).toEqual([at(files, "usecjs.js", "SHOWN")]);
    expect(callSites(g, symbol(g, "cjs.js", "hidden"))).toEqual([]);
  });

  it("keeps static and instance methods of one name apart (6)", async () => {
    const files = {
      "c.ts": [
        "export class C {",
        "  static run() {}",
        "  run() {}",
        "  static make() {",
        "    return this.run(); // STATICTHIS",
        "  }",
        "}",
        "C.run(); // CLASSCALL",
        "new C().run(); // INSTANCE",
      ].join("\n"),
      "c.rb": ["class R", "  def self.run", "  end", "", "  def run", "  end", "end", "", "R.run # RSTATIC", "R.new.run # RINSTANCE"].join("\n"),
    };
    const g = await build(repo(files));
    const statics = (g.defsByFile.get("c.ts") ?? []).filter((n) => n.name === "run");
    expect(statics).toHaveLength(2);
    const [s, i] = statics as [{ id: string }, { id: string }];
    expect(callSites(g, s.id)).toEqual([at(files, "c.ts", "STATICTHIS"), at(files, "c.ts", "CLASSCALL")].sort());
    expect(callSites(g, i.id)).toEqual([at(files, "c.ts", "INSTANCE")]);
    const [rs, ri] = (g.defsByFile.get("c.rb") ?? []).filter((n) => n.name === "run") as [{ id: string }, { id: string }];
    expect(callSites(g, rs.id)).toEqual([at(files, "c.rb", "RSTATIC")]);
    expect(callSites(g, ri.id)).toEqual([at(files, "c.rb", "RINSTANCE")]);
  });

  it("drops the receiver type of a local that is reassigned to another value (7)", async () => {
    const files = {
      "x.ts": [
        "class A { run() {} }",
        "class B { run() {} }",
        "declare function unknown(): any;",
        "export function f() {",
        "  let x = new A();",
        "  x = new B();",
        "  x.run(); // AFTERB",
        "  let y = new A();",
        "  y = unknown();",
        "  y.run(); // AFTERUNKNOWN",
        "  const z = new A();",
        "  z.run(); // KEPT",
        "}",
      ].join("\n"),
      "x.py": ["class A:", "    def run(self):", "        pass", "", "def f(other):", "    x = A()", "    x = other", "    x.run()  # PYREASSIGNED"].join("\n"),
    };
    const g = await build(repo(files));
    expect(callSites(g, symbol(g, "x.ts", "run", "A"))).toEqual([at(files, "x.ts", "KEPT")]);
    expect(callSites(g, symbol(g, "x.py", "run", "A"))).toEqual([]);
  });

  it("binds a Python alias that repeats the package name to the module it names (8)", async () => {
    const files = {
      "pkg/__init__.py": "def target():\n    pass\n",
      "pkg/a.py": "def target():\n    pass\n",
      "use.py": "import pkg.a as pkg\n\npkg.target()  # ALIAS\n",
    };
    const g = await build(repo(files));
    expect(callSites(g, symbol(g, "pkg/a.py", "target"))).toEqual([at(files, "use.py", "ALIAS")]);
    expect(callSites(g, symbol(g, "pkg/__init__.py", "target"))).toEqual([]);
  });

  it("keeps a Go external test package apart from the package it tests (9)", async () => {
    const files = {
      "go.mod": "module example.com/m\n",
      "store/store.go": "package store\n\nfunc Target() {}\n",
      "store/store_ext_test.go": 'package store_test\n\nimport "example.com/m/store"\n\nfunc Target() {}\n\nfunc TestX() {\n\tstore.Target() // VIAIMPORT\n\tTarget() // OWNTEST\n}\n',
      "cmd/main.go": 'package main\n\nimport "example.com/m/store"\n\nfunc main() {\n\tstore.Target() // MAIN\n}\n',
    };
    const g = await build(repo(files));
    expect(callSites(g, symbol(g, "store/store.go", "Target"))).toEqual([at(files, "cmd/main.go", "MAIN"), at(files, "store/store_ext_test.go", "VIAIMPORT")].sort());
    expect(callSites(g, symbol(g, "store/store_ext_test.go", "Target"))).toEqual([at(files, "store/store_ext_test.go", "OWNTEST")]);
  });

  it("makes a function assigned inside a function a symbol of its own, the caller of what it calls (10)", async () => {
    const files = {
      "n.ts": ["export function target() {}", "export function outer() {", "  const inner = () => target(); // INNER", "  inner(); // OUTER", "}"].join("\n"),
    };
    const g = await build(repo(files));
    const inner = symbol(g, "n.ts", "inner", "outer");
    expect(g.in.get(symbol(g, "n.ts", "target"))?.map((e) => e.from)).toEqual([inner]);
    expect(callSites(g, inner)).toEqual([at(files, "n.ts", "OUTER")]);
  });

  it("keeps a recursive call site, and the impact walk does not list a symbol as its own caller (13)", async () => {
    const files = { "r.ts": "export function fact(n: number): number {\n  return n <= 1 ? 1 : n * fact(n - 1);\n}\n" };
    const root = repo(files);
    commitAll(root);
    writeFiles(root, { "r.ts": "export function fact(n: number): number {\n  return n <= 0 ? 1 : n * fact(n - 1);\n}\n" });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await build(root, { files: change.changedPaths });
    expect(callSites(g, symbol(g, "r.ts", "fact"))).toEqual(["r.ts:2"]);
    expect(detectImpact(g, change).callers).toEqual([]);
  });
});

describe("removed symbols", () => {
  const files = {
    "a.ts": "export function gone() {}\nexport function kept() {}\n",
    "b.ts": 'import { gone, kept } from "./a";\ngone();\nkept();\n',
  };

  it("reports nothing removed from a changed file the size cap left out (11)", async () => {
    const root = repo(files);
    commitAll(root);
    writeFiles(root, { "a.ts": `export function gone() {}\nexport function kept() {}\n// ${"x".repeat(2000)}\n` });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await build(root, { files: change.changedPaths, maxFileBytes: 1000, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    expect(impact.removed).toEqual([]);
    expect(impact.status).toBe("partial");
  });

  it("counts base versions against the file cap and says removal was not checked (12)", async () => {
    const root = repo(files);
    commitAll(root);
    writeFiles(root, { "a.ts": "export function kept() {}\n" });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await build(root, { files: change.changedPaths, maxFiles: 2, base: { sha: change.baseSha, files: change.files } });
    expect(g.status.parses).toBe(2);
    expect(g.status.status).toBe("partial");
    expect(g.status.reasons).toContain("removed symbols were not checked in 1 changed file");
  });
});
