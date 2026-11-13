// Ways the call resolution could fail, per language, each checked below on a
// small real repo whose callers are known by hand:
// 1. A call through an import alias (`import { target as t }`, `require`,
//    `from x import target as t`, a Go package alias) is missed. Java has no
//    import alias: its case is a static import and an explicit type import.
// 2. A method call on a receiver whose type a constructor or an annotation
//    gives is missed.
// 3. A same-named function in another file is taken for the target (a name
//    match without evidence).
// 4. A method call on a receiver of unknown type is bound because some
//    imported file defines a method of that name.
// 5. A call site's line is wrong or only the first site of a pair is kept.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import { at, callSites, makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

async function graphOf(files: Record<string, string>) {
  const root = makeRepo(files);
  return buildGraph({ repoRoot: root, store: null });
}

describe("typescript", () => {
  const files = {
    "tsconfig.json": '{\n  // aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } }\n}\n',
    "src/lib/a.ts": [
      "export function target(x: number): number {",
      "  return x + 1;",
      "}",
      "export class Svc {",
      "  target(): void {}",
      "}",
    ].join("\n"),
    "src/b.ts": ['import { target as t } from "./lib/a.js";', "export function useAlias() {", "  t(1); // ALIAS", "  t(2); // ALIAS2", "}"].join("\n"),
    "src/c.ts": [
      'import { Svc } from "@lib/a";',
      "export class Runner {",
      "  constructor(private readonly svc: Svc) {}",
      "  go(): void {",
      "    const s = new Svc(); // NEW",
      "    s.target(); // TYPED",
      "    this.svc.target(); // FIELD",
      "  }",
      "}",
    ].join("\n"),
    "src/d.ts": ["export function target() {}", "export const local = () => target(); // OWN"].join("\n"),
    "src/e.ts": ['import { target } from "./lib/a.js";', "export function untyped(obj: any) {", "  obj.target(); // UNTYPED", "  return target;", "}"].join("\n"),
  };

  it("binds an aliased import, a typed receiver and a constructor-typed field, and never a same-named function or an untyped receiver", async () => {
    const g = await graphOf(files);
    expect(callSites(g, symbol(g, "src/lib/a.ts", "target"))).toEqual([at(files, "src/b.ts", "ALIAS"), at(files, "src/b.ts", "ALIAS2")].sort());
    expect(callSites(g, symbol(g, "src/lib/a.ts", "target", "Svc"))).toEqual([at(files, "src/c.ts", "TYPED"), at(files, "src/c.ts", "FIELD")].sort());
    expect(callSites(g, symbol(g, "src/d.ts", "target"))).toEqual([at(files, "src/d.ts", "OWN")]);
    expect(callSites(g, symbol(g, "src/lib/a.ts", "Svc"))).toEqual([at(files, "src/c.ts", "NEW")]);
  });
});

describe("tsx", () => {
  const files = {
    "ui/button.tsx": ["export function Button() {", "  return <button />;", "}", "export function label(): string {", '  return "x";', "}"].join("\n"),
    "ui/page.tsx": [
      'import { Button as B, label } from "./button";',
      "export function Page() {",
      "  const text = label(); // LABEL",
      "  return <div><B /></div>; // JSX",
      "}",
    ].join("\n"),
    "ui/other.tsx": ["function Button() {", "  return null;", "}", "export const Other = () => <Button />; // OWN"].join("\n"),
  };

  it("counts a JSX element as a call of the imported component under its alias, and keeps a same-named local component apart", async () => {
    const g = await graphOf(files);
    expect(callSites(g, symbol(g, "ui/button.tsx", "Button"))).toEqual([at(files, "ui/page.tsx", "JSX")]);
    expect(callSites(g, symbol(g, "ui/button.tsx", "label"))).toEqual([at(files, "ui/page.tsx", "LABEL")]);
    expect(callSites(g, symbol(g, "ui/other.tsx", "Button"))).toEqual([at(files, "ui/other.tsx", "OWN")]);
  });
});

describe("javascript", () => {
  const files = {
    "lib/a.js": ["function target() {}", "class Svc {", "  target() {}", "}", "module.exports = { target, Svc };"].join("\n"),
    "lib/b.js": ['const { target: t, Svc } = require("./a");', "function main() {", "  t(); // ALIAS", "  const s = new Svc();", "  s.target(); // TYPED", "}"].join("\n"),
    "lib/c.js": ['const a = require("./a");', "function viaNs() {", "  a.target(); // NS", "}", "function target() {}", "function own() {", "  target(); // OWN", "}"].join("\n"),
    "lib/d.js": ['require("./a");', "function untyped(x) {", "  x.target(); // UNTYPED", "}"].join("\n"),
  };

  it("binds require aliases and a required namespace, and never an untyped receiver", async () => {
    const g = await graphOf(files);
    expect(callSites(g, symbol(g, "lib/a.js", "target"))).toEqual([at(files, "lib/b.js", "ALIAS"), at(files, "lib/c.js", "NS")].sort());
    expect(callSites(g, symbol(g, "lib/a.js", "target", "Svc"))).toEqual([at(files, "lib/b.js", "TYPED")]);
    expect(callSites(g, symbol(g, "lib/c.js", "target"))).toEqual([at(files, "lib/c.js", "OWN")]);
  });
});

describe("python", () => {
  const files = {
    "pkg/__init__.py": "",
    "pkg/a.py": ["def target(x):", "    return x", "", "class Svc:", "    def target(self):", "        return self.helper()  # SELF", "", "    def helper(self):", "        return 1"].join("\n"),
    "pkg/b.py": ["from pkg.a import target as t", "", "def use_alias():", "    t(1)  # ALIAS"].join("\n"),
    "pkg/c.py": [
      "from .a import Svc",
      "import pkg.a",
      "",
      "def typed(svc: Svc):",
      "    svc.target()  # ANNOTATED",
      "    s = Svc()  # CTOR",
      "    s.target()  # CONSTRUCTED",
      "    pkg.a.target(2)  # MODULE",
    ].join("\n"),
    "pkg/d.py": ["def target():", "    pass", "", "def own():", "    target()  # OWN"].join("\n"),
    "pkg/e.py": ["from pkg import a", "", "def untyped(obj):", "    obj.target()  # UNTYPED", "    a.target(3)  # SUBMODULE"].join("\n"),
  };

  it("binds an aliased from-import, a module path, an annotated and a constructed receiver, and self; never an untyped receiver", async () => {
    const g = await graphOf(files);
    expect(callSites(g, symbol(g, "pkg/a.py", "target"))).toEqual(
      [at(files, "pkg/b.py", "ALIAS"), at(files, "pkg/c.py", "MODULE"), at(files, "pkg/e.py", "SUBMODULE")].sort(),
    );
    expect(callSites(g, symbol(g, "pkg/a.py", "target", "Svc"))).toEqual([at(files, "pkg/c.py", "ANNOTATED"), at(files, "pkg/c.py", "CONSTRUCTED")].sort());
    expect(callSites(g, symbol(g, "pkg/a.py", "helper", "Svc"))).toEqual([at(files, "pkg/a.py", "SELF")]);
    expect(callSites(g, symbol(g, "pkg/d.py", "target"))).toEqual([at(files, "pkg/d.py", "OWN")]);
    expect(callSites(g, symbol(g, "pkg/a.py", "Svc"))).toEqual([at(files, "pkg/c.py", "CTOR")]);
  });
});

describe("go", () => {
  const files = {
    "go.mod": "module example.com/m\n\ngo 1.22\n",
    "store/store.go": ["package store", "", "func Target() int { return 1 }", "", "type Svc struct{ inner *Svc }", "", "func (s *Svc) Target() int { return Helper() } // SAMEPKG"].join("\n"),
    "store/helper.go": ["package store", "", "func Helper() int { return 2 }"].join("\n"),
    "cmd/main.go": [
      "package main",
      "",
      'import st "example.com/m/store"',
      "",
      "func run(p *st.Svc) {",
      "\tst.Target() // ALIAS",
      "\ts := &st.Svc{}",
      "\ts.Target() // LITERAL",
      "\tp.Target() // PARAM",
      "\tx := make()",
      "\tx.Target() // UNTYPED",
      "}",
      "",
      "func make() any { return nil }",
    ].join("\n"),
    "other/other.go": ["package other", "", "func Target() int { return 3 }", "", "func Own() int { return Target() } // OWN"].join("\n"),
  };

  it("binds a package alias, a same-package call in another file, a composite literal and a typed parameter; never an untyped receiver", async () => {
    const g = await graphOf(files);
    expect(callSites(g, symbol(g, "store/store.go", "Target"))).toEqual([at(files, "cmd/main.go", "ALIAS")]);
    expect(callSites(g, symbol(g, "store/store.go", "Target", "Svc"))).toEqual([at(files, "cmd/main.go", "LITERAL"), at(files, "cmd/main.go", "PARAM")].sort());
    expect(callSites(g, symbol(g, "store/helper.go", "Helper"))).toEqual([at(files, "store/store.go", "SAMEPKG")]);
    expect(callSites(g, symbol(g, "other/other.go", "Target"))).toEqual([at(files, "other/other.go", "OWN")]);
  });
});

describe("java", () => {
  const files = {
    "pom.xml": "<project><groupId>a</groupId><artifactId>m</artifactId></project>\n",
    "src/main/java/a/store/Store.java": [
      "package a.store;",
      "",
      "public class Store {",
      "  public static int target() { return Helper.help(); } // SAMEPKG",
      "  public int find(String id) { return 1; }",
      "}",
    ].join("\n"),
    "src/main/java/a/store/Helper.java": ["package a.store;", "", "public class Helper {", "  public static int help() { return 2; }", "}"].join("\n"),
    "src/main/java/a/app/Main.java": [
      "package a.app;",
      "",
      "import static a.store.Store.target;",
      "import a.store.Store;",
      "",
      "public class Main {",
      "  void run(Store p) {",
      "    target(); // STATIC",
      "    Store.target(); // TYPE",
      "    var v = new Store();",
      "    v.find(\"x\"); // CTOR",
      "    p.find(\"y\"); p.find(\"z\"); // PARAM",
      "    apply(x -> x.find(\"w\")); // UNTYPED",
      "  }",
      "",
      "  void apply(Object f) {}",
      "}",
    ].join("\n"),
    "src/main/java/a/other/Other.java": [
      "package a.other;",
      "",
      "public class Other {",
      "  public static int target() { return 3; }",
      "  public int find(String id) { return 4; }",
      "  int own() { return target(); } // OWN",
      "}",
    ].join("\n"),
  };

  it("binds a static import, an explicit type import, a same-package type, a constructed and a parameter receiver, two sites on one line; never a same-named method elsewhere or an untyped receiver", async () => {
    const g = await graphOf(files);
    const main = "src/main/java/a/app/Main.java";
    expect(callSites(g, symbol(g, "src/main/java/a/store/Store.java", "target", "Store"))).toEqual([at(files, main, "STATIC"), at(files, main, "TYPE")].sort());
    expect(callSites(g, symbol(g, "src/main/java/a/store/Store.java", "find", "Store"))).toEqual([at(files, main, "CTOR"), at(files, main, "PARAM"), at(files, main, "PARAM")].sort());
    expect(callSites(g, symbol(g, "src/main/java/a/store/Helper.java", "help", "Helper"))).toEqual([at(files, "src/main/java/a/store/Store.java", "SAMEPKG")]);
    expect(callSites(g, symbol(g, "src/main/java/a/other/Other.java", "target", "Other"))).toEqual([at(files, "src/main/java/a/other/Other.java", "OWN")]);
    expect(callSites(g, symbol(g, "src/main/java/a/other/Other.java", "find", "Other"))).toEqual([]);
  });
});

describe("ruby", () => {
  const files = {
    "app/models/svc.rb": ["class Svc", "  def target", "    helper # IMPLICIT", "  end", "", "  def helper", "    1", "  end", "", "  def self.build", "    new # SELFNEW", "  end", "end"].join("\n"),
    "app/services/util.rb": ["module Util", "  def self.target", "    2", "  end", "end"].join("\n"),
    "app/services/runner.rb": [
      "class Runner",
      "  def go(x)",
      "    s = Svc.new # NEW",
      "    s.target # TYPED",
      "    Util.target # CONST",
      "    x.target # UNTYPED",
      "    helper = 3",
      "    helper",
      "  end",
      "end",
    ].join("\n"),
    "app/services/other.rb": ["class Other", "  def target", "    3", "  end", "", "  def go", "    target # OWN", "  end", "end"].join("\n"),
  };

  it("binds a constructed receiver, a constant receiver and an implicit self call; never an untyped receiver or a local variable", async () => {
    const g = await graphOf(files);
    expect(callSites(g, symbol(g, "app/models/svc.rb", "target", "Svc"))).toEqual([at(files, "app/services/runner.rb", "TYPED")]);
    expect(callSites(g, symbol(g, "app/models/svc.rb", "helper", "Svc"))).toEqual([at(files, "app/models/svc.rb", "IMPLICIT")]);
    expect(callSites(g, symbol(g, "app/services/util.rb", "target", "Util"))).toEqual([at(files, "app/services/runner.rb", "CONST")]);
    expect(callSites(g, symbol(g, "app/services/other.rb", "target", "Other"))).toEqual([at(files, "app/services/other.rb", "OWN")]);
    expect(callSites(g, symbol(g, "app/models/svc.rb", "Svc"))).toEqual([at(files, "app/models/svc.rb", "SELFNEW"), at(files, "app/services/runner.rb", "NEW")].sort());
  });
});
