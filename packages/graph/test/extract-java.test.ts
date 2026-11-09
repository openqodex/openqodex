// The Java facts one parse of one file yields, against the fact contract of
// the Java graph plan: each test parses a small real source with the
// shipped grammar and checks one line of the contract. A failure here
// means the resolver reads a wrong shape and binds or drops calls wrongly.
import { describe, expect, it } from "vitest";
import { extract } from "../src/extract.js";
import { parserFor } from "../src/parser.js";
import { stableKey, symbolId } from "../src/resolve.js";
import { isFileFacts } from "../src/safe-fs.js";
import type { CallFact, DefFact, FileFacts } from "../src/types.js";

async function factsOf(lines: string[]): Promise<FileFacts> {
  const parser = await parserFor("java");
  const tree = parser.parse(lines.join("\n"));
  if (!tree) throw new Error("no tree");
  return extract(tree, "java");
}

function def(f: FileFacts, name: string, owner?: string | null): DefFact {
  const hits = f.defs.filter((d) => d.name === name && (owner === undefined || d.owner === owner));
  if (hits.length !== 1) throw new Error(`${hits.length} definitions named ${name}`);
  return hits[0] as DefFact;
}

function calls(f: FileFacts, name: string): CallFact[] {
  return f.calls.filter((c) => c.name === name);
}

function one(f: FileFacts, name: string): CallFact {
  const hits = calls(f, name);
  if (hits.length !== 1) throw new Error(`${hits.length} calls named ${name}`);
  return hits[0] as CallFact;
}

function callerName(f: FileFacts, c: CallFact): string | null {
  return c.caller >= 0 ? (f.defs[c.caller] as DefFact).name : null;
}

describe("java facts", () => {
  it("a package-private class is not exported", async () => {
    const f = await factsOf(["package a.b;", "class Hidden {}", "public class Shown {}"]);
    expect(f.lang).toBe("java");
    expect(f.javaPackage).toBe("a.b");
    expect(def(f, "Hidden")).toMatchObject({ kind: "class", owner: null, topLevel: true, exported: false });
    expect(def(f, "Shown")).toMatchObject({ kind: "class", owner: null, topLevel: true, exported: true });
  });

  it("a file without a package declaration is in the default package", async () => {
    const f = await factsOf(["class A {}"]);
    expect(f.javaPackage).toBeNull();
  });

  it("a class's extends and implements are bases with the superclass first, and an interface's extends are all plain bases", async () => {
    const f = await factsOf(["class A extends Base<String> implements I, a.b.J<X> {}", "interface K extends L, M<N> {}", "@interface Ann {}"]);
    expect(def(f, "A").bases.map((b) => [b.name, b.qualifier, b.rel])).toEqual([
      ["Base", null, undefined],
      ["I", null, "implements"],
      ["J", "a.b", "implements"],
    ]);
    expect(def(f, "K")).toMatchObject({ kind: "class", iface: true });
    expect(def(f, "K").bases.map((b) => [b.name, b.rel])).toEqual([
      ["L", undefined],
      ["M", undefined],
    ]);
    expect(def(f, "Ann")).toMatchObject({ kind: "class", iface: true });
    expect(def(f, "A").iface).toBeUndefined();
  });

  it("an enum and a record are classes and take implements", async () => {
    const f = await factsOf(["enum E implements Z { X, Y }", "record R(int a) implements Q {}"]);
    expect(def(f, "E")).toMatchObject({ kind: "class", topLevel: true });
    expect(def(f, "E").bases.map((b) => [b.name, b.rel])).toEqual([["Z", "implements"]]);
    expect(def(f, "R").bases.map((b) => [b.name, b.rel])).toEqual([["Q", "implements"]]);
  });

  it("fields are raw types: generics stripped, arrays as elem, primitives an entry that names no class", async () => {
    const f = await factsOf(["class A {", "  void m() {}", "  private List<Item> items;", "  Item[] arr;", "  int count;", "  a.b.C qualified;", "}"]);
    const fields = def(f, "A").fields;
    expect(Object.keys(fields).sort()).toEqual(["arr", "count", "items", "qualified"]);
    expect(fields.count).toMatchObject({ name: "", qualifier: null });
    expect(fields.items).toMatchObject({ name: "List", qualifier: null });
    expect(fields.items?.elem).toBeUndefined();
    expect(fields.arr).toMatchObject({ name: "Item", qualifier: null, elem: true });
    expect(fields.qualified).toMatchObject({ name: "C", qualifier: "a.b" });
  });

  it("a record's components are fields", async () => {
    const f = await factsOf(["record R(int a, Svc b, List<Item> c) {}"]);
    const fields = def(f, "R").fields;
    expect(Object.keys(fields).sort()).toEqual(["a", "b", "c"]);
    expect(fields.a).toMatchObject({ name: "" });
    expect(fields.b).toMatchObject({ name: "Svc", qualifier: null });
    expect(fields.c).toMatchObject({ name: "List", qualifier: null });
  });

  it("a method records its owner, static, params and declared result, with void and primitives as null", async () => {
    const f = await factsOf(["public class A {", "  public static Svc make(String s, int n) { return null; }", "  void run() {}", "  int count() { return 1; }", "  List<Item> items() { return null; }", "}"]);
    expect(def(f, "make")).toMatchObject({ kind: "method", owner: "A", static: true, exported: true, topLevel: false, params: ["s", "n"] });
    expect(def(f, "make").results).toMatchObject([{ name: "Svc", qualifier: null }]);
    expect(def(f, "run").results).toEqual([null]);
    expect(def(f, "run").static).toBeFalsy();
    expect(def(f, "run").exported).toBe(false);
    expect(def(f, "count").results).toEqual([null]);
    expect(def(f, "items").results).toMatchObject([{ name: "List", qualifier: null }]);
  });

  it("an interface method without a body is abstract and a default method is not", async () => {
    const f = await factsOf([
      "interface I {",
      "  void a();",
      "  default void b() { a(); }",
      "  static void c() {}",
      "}",
      "abstract class Base {",
      "  abstract void run();",
      "  void go() { run(); }",
      "}",
    ]);
    expect(def(f, "a")).toMatchObject({ owner: "I", abstract: true, exported: true });
    expect(def(f, "b").abstract).toBeFalsy();
    expect(def(f, "c").abstract).toBeFalsy();
    expect(def(f, "c").static).toBe(true);
    expect(def(f, "run").abstract).toBe(true);
    expect(def(f, "go").abstract).toBeFalsy();
  });

  it("a constructor is a method named like its class with ctor and is not static", async () => {
    const f = await factsOf(["public class A {", "  public A(Repo r, int n) {}", "}"]);
    const ctor = f.defs.find((d) => d.kind === "method" && d.name === "A") as DefFact;
    expect(ctor).toMatchObject({ kind: "method", name: "A", owner: "A", ctor: true, params: ["r", "n"] });
    expect(ctor.static).toBeFalsy();
    expect(ctor.results).toMatchObject([{ name: "A", qualifier: null }]);
  });

  it("calls inside a constructor body are not static calls", async () => {
    const f = await factsOf(["class A {", "  A() { this.init(); setup(); }", "  static void make() { helper(); }", "  void init() {}", "}"]);
    expect(one(f, "init").static).toBeFalsy();
    expect(one(f, "setup").static).toBeFalsy();
    expect(callerName(f, one(f, "init"))).toBe("A");
    // Control: a static method's calls are static.
    expect(one(f, "helper").static).toBe(true);
  });

  it("calls in an instance field initializer are not static, and calls in a static one are", async () => {
    const f = await factsOf(["class A {", "  Svc s = inst();", "  static Svc t = stat();", "  static { boot(); }", "}"]);
    expect(one(f, "inst").static).toBeFalsy();
    expect(one(f, "stat").static).toBe(true);
    expect(one(f, "boot").static).toBe(true);
  });

  it("a varargs method records varargs", async () => {
    const f = await factsOf(["class A {", "  void fmt(String f, Object... rest) {}", "  void log(String s) {}", "}"]);
    expect(def(f, "fmt")).toMatchObject({ varargs: true, params: ["f", "rest"] });
    expect(def(f, "log").varargs).toBeUndefined();
  });

  it("every import carries the required fields", async () => {
    const f = await factsOf(["import a.b.C;", "import a.b.*;", "class A {}"]);
    expect(f.imports).toEqual([
      { spec: "a.b", line: 1, column: 1, names: [{ imported: "C", local: "C" }], namespace: null, star: false, reexport: false, typeOnly: false },
      { spec: "a.b", line: 2, column: 1, names: [], namespace: null, star: true, reexport: false, typeOnly: false },
    ]);
  });

  it("a static import carries staticMember", async () => {
    const f = await factsOf(["import static a.b.Util.helper;", "class A {}"]);
    expect(f.imports).toEqual([
      { spec: "a.b", line: 1, column: 1, names: [{ imported: "Util", local: "Util" }], namespace: null, star: false, reexport: false, typeOnly: false, staticMember: "helper" },
    ]);
  });

  it("a static star import carries staticStar", async () => {
    const f = await factsOf(["import static a.b.Util.*;", "class A {}"]);
    expect(f.imports).toEqual([
      { spec: "a.b", line: 1, column: 1, names: [{ imported: "Util", local: "Util" }], namespace: null, star: false, reexport: false, typeOnly: false, staticStar: true },
    ]);
  });

  it("a call records its argument count", async () => {
    const f = await factsOf(["class A {", "  void m(Svc s) {", "    none();", "    two(1, \"x\");", "    s.three(a, b, c);", "    new Svc(1, 2);", "  }", "}"]);
    expect(one(f, "none").arity).toBe(0);
    expect(one(f, "two").arity).toBe(2);
    expect(one(f, "three").arity).toBe(3);
    expect(one(f, "Svc").arity).toBe(2);
  });

  it("a call whose argument list did not parse has no arity", async () => {
    const f = await factsOf(["class A {", "  void m() {", "    broken(1, );", "  }", "}"]);
    expect(one(f, "broken").arity).toBeUndefined();
  });

  it("a bare call in a type body is a self receiver", async () => {
    const f = await factsOf(["class A {", "  void m() { helper(); this.other(); }", "}"]);
    expect(one(f, "helper").recv).toEqual({ kind: "self", path: [] });
    expect(one(f, "other").recv).toEqual({ kind: "self", path: [] });
    expect(callerName(f, one(f, "helper"))).toBe("m");
  });

  it("a bare field call is a self receiver with the field path when the field is declared below the method", async () => {
    const f = await factsOf(["class A {", "  void m() { repo.find(); this.repo.save(); }", "  private Repo repo;", "}"]);
    expect(one(f, "find").recv).toEqual({ kind: "self", path: ["repo"] });
    expect(one(f, "save").recv).toEqual({ kind: "self", path: ["repo"] });
  });

  it("a local or a parameter hides a field of the same name", async () => {
    const f = await factsOf(["class A {", "  Repo repo;", "  void m(Other repo) { repo.find(); }", "}"]);
    expect(one(f, "find").recv).toMatchObject({ kind: "type", type: { name: "Other", declared: true }, path: [] });
  });

  it("super.m() is a super receiver", async () => {
    const f = await factsOf(["class A extends B {", "  void m() { super.m(); }", "}"]);
    expect(one(f, "m").recv).toEqual({ kind: "super" });
  });

  it("a typed local, a parameter and a var from a constructor give type receivers", async () => {
    const f = await factsOf([
      "class A {",
      "  void m(Repo p, List<Item> items) {",
      "    Svc s = make();",
      "    s.a();",
      "    p.b();",
      "    var v = new Mem();",
      "    v.c();",
      "    for (Item i : items) i.d();",
      "    try { x(); } catch (IOException e) { e.f(); }",
      "    Runnable q = (String t) -> t.g();",
      "    if (o instanceof Svc sv) sv.h();",
      "  }",
      "}",
    ]);
    const typeOf = (name: string) => {
      const r = one(f, name).recv;
      return r.kind === "type" ? r.type : null;
    };
    expect(typeOf("a")).toMatchObject({ name: "Svc", qualifier: null, declared: true });
    expect(typeOf("b")).toMatchObject({ name: "Repo", qualifier: null, declared: true });
    const v = typeOf("c");
    expect(v).toMatchObject({ name: "Mem", qualifier: null });
    expect(v?.declared).toBeUndefined();
    expect(v?.result).toBeUndefined();
    expect(typeOf("d")).toMatchObject({ name: "Item", declared: true });
    expect(typeOf("f")).toMatchObject({ name: "IOException", declared: true });
    expect(typeOf("g")).toMatchObject({ name: "String", declared: true });
    expect(typeOf("h")).toMatchObject({ name: "Svc", declared: true });
  });

  it("a lambda parameter without a type is an untyped receiver", async () => {
    const f = await factsOf(["class A {", "  void m() { run(x -> x.go()); }", "}"]);
    expect(one(f, "go").recv).toEqual({ kind: "other" });
  });

  it("a call on a call result is a type receiver with result 0", async () => {
    const f = await factsOf(["class A {", "  void m() {", "    make().run();", "    Factory.build().go();", "  }", "}"]);
    expect(one(f, "run").recv).toMatchObject({ kind: "type", type: { name: "make", qualifier: null, result: 0 }, path: [] });
    expect(one(f, "go").recv).toMatchObject({ kind: "type", type: { name: "build", qualifier: "Factory", result: 0 }, path: [] });
  });

  it("a call on a typed local's method result carries the local's type in on", async () => {
    const f = await factsOf(["class A {", "  void m(Repo r) {", "    Repo s = r;", "    s.find(1).normalize();", "    var t = r.find(2);", "    t.close();", "  }", "}"]);
    expect(one(f, "normalize").recv).toMatchObject({ kind: "type", type: { name: "find", qualifier: null, result: 0, on: { name: "Repo", declared: true } }, path: [] });
    expect(one(f, "close").recv).toMatchObject({ kind: "type", type: { name: "find", result: 0, on: { name: "Repo" } } });
  });

  it("a call on a field's method result carries the field's type in on", async () => {
    const f = await factsOf(["class A {", "  private Repo repo;", "  void m() {", "    repo.find(1).normalize();", "    this.repo.find(2).close();", "  }", "}"]);
    expect(one(f, "normalize").recv).toMatchObject({ kind: "type", type: { name: "find", qualifier: null, result: 0, on: { name: "Repo" } } });
    expect(one(f, "close").recv).toMatchObject({ kind: "type", type: { name: "find", qualifier: null, result: 0, on: { name: "Repo" } } });
  });

  it("a chain of two calls nests on", async () => {
    const f = await factsOf(["class A {", "  void m(Repo r) {", "    r.find(1).item().normalize();", "  }", "}"]);
    expect(one(f, "normalize").recv).toMatchObject({ kind: "type", type: { name: "item", result: 0, on: { name: "find", result: 0, on: { name: "Repo" } } } });
    expect(isFileFacts(f)).toBe(true);
  });

  it("a call on an other receiver is still recorded", async () => {
    const f = await factsOf(["class A {", "  void m(Object[] xs) {", "    xs[0].toString().trim();", "  }", "}"]);
    expect(one(f, "trim").recv).toEqual({ kind: "other" });
  });

  it("10. an instanceof pattern variable is typed in the consequence only, and after the if it is never read as the field", async () => {
    const f = await factsOf(["class A {", "  Foo x;", "  void m(Object o) {", "    if (o instanceof Bar x) {", "      x.run();", "    }", "    x.go();", "  }", "}"]);
    expect(one(f, "run").recv).toMatchObject({ kind: "type", type: { name: "Bar" } });
    expect(one(f, "go").recv).toEqual({ kind: "other" });
  });

  it("12. a field whose type is a type parameter or a primitive is recorded so it hides a superclass field", async () => {
    const f = await factsOf(["class A<T> extends B {", "  T r;", "  int n;", "}"]);
    expect(Object.keys(def(f, "A").fields).sort()).toEqual(["n", "r"]);
    expect(isFileFacts(f)).toBe(true);
  });

  it("14. an array dimension after a name makes the parameter, field and local an array", async () => {
    const f = await factsOf(["class A {", "  Foo fs[];", "  void m(Foo xs[]) {", "    Foo ls[] = null;", "  }", "}"]);
    expect(def(f, "A").fields.fs).toMatchObject({ name: "Foo", elem: true });
    const g = await factsOf(["class A {", "  void m(Foo xs[]) {", "    xs.clone();", "    Foo ls[] = null;", "    ls.clone();", "  }", "}"]);
    expect(calls(g, "clone").map((c) => c.recv.kind)).toEqual(["other", "other"]);
  });

  it("3. new T() marks its call ctor and a method call does not", async () => {
    const f = await factsOf(["class A {", "  void m() {", "    new T();", "    T.T();", "  }", "}"]);
    expect(calls(f, "T").map((c) => c.ctor === true)).toEqual([true, false]);
    expect(isFileFacts(f)).toBe(true);
  });

  it("9. this(...) and super(...) are constructor calls on the own class and the super receiver", async () => {
    const f = await factsOf(["class C extends B {", "  C() {", "    super(1);", "  }", "  C(int a) {", "    this();", "  }", "}"]);
    expect(calls(f, "B")).toMatchObject([{ recv: { kind: "super" }, ctor: true, arity: 1 }]);
    expect(calls(f, "C")).toMatchObject([{ recv: { kind: "self", path: [] }, ctor: true, arity: 0 }]);
  });

  it("d2. a private interface method is not exported", async () => {
    const f = await factsOf(["public interface I {", "  void a();", "  private void b() {}", "  default void c() { b(); }", "}"]);
    expect(def(f, "a").exported).toBe(true);
    expect(def(f, "b").exported).toBe(false);
  });

  it("d5. a pattern variable in a field initializer stays in that initializer", async () => {
    const f = await factsOf(["class A {", "  Foo x;", "  boolean ok = o() instanceof Bar x;", "  void m() {", "    x.go();", "  }", "  Object o() { return null; }", "}"]);
    expect(one(f, "go").recv).toEqual({ kind: "self", path: ["x"] });
  });

  it("d9. a long chain of calls and var locals keeps on within the validator's depth, so the facts are kept", async () => {
    const chain = Array.from({ length: 30 }, (_, i) => `m${i}()`).join(".");
    const vars = Array.from({ length: 30 }, (_, i) => `    var v${i + 1} = v${i}.m();`);
    const f = await factsOf(["class A {", "  void m(Repo v0) {", `    v0.${chain}.end();`, ...vars, "    v30.end();", "  }", "}"]);
    expect(isFileFacts(f)).toBe(true);
  });

  it("e4. a call in an interface constant or an enum constant's arguments is static, and one in its anonymous body is not", async () => {
    const f = await factsOf(["interface I {", "  int K = make();", "}", "enum E {", "  A(build()) {", "    void m() { inner(); }", "  };", "  E(int x) {}", "}"]);
    expect(one(f, "make").static).toBe(true);
    expect(one(f, "build").static).toBe(true);
    expect(one(f, "inner").static).toBeUndefined();
  });

  it("e6. a switch case pattern and a record pattern bind their variables as typed locals", async () => {
    const f = await factsOf([
      "class A {",
      "  Object c;",
      "  void m(Object o) {",
      "    switch (o) { case Circle c -> c.area(); default -> {} }",
      "    switch (o) { case Square c: c.side(); break; default: break; }",
      "    if (o instanceof Point(int x, Svc y)) { y.go(); }",
      "  }",
      "}",
    ]);
    expect(one(f, "area").recv).toMatchObject({ kind: "type", type: { name: "Circle" } });
    expect(one(f, "side").recv).toMatchObject({ kind: "type", type: { name: "Square" } });
    expect(one(f, "go").recv).toMatchObject({ kind: "type", type: { name: "Svc" } });
  });

  it("Type.m() is a name receiver", async () => {
    const f = await factsOf(["class A {", "  void m() { Type.m2(); a.b.Util.m3(); }", "}"]);
    expect(one(f, "m2").recv).toEqual({ kind: "name", name: "Type", path: [], nesting: null });
    expect(one(f, "m3").recv).toEqual({ kind: "name", name: "a", path: ["b", "Util"], nesting: null });
  });

  it("new T(args) is a call named T on a receiver that names T", async () => {
    const f = await factsOf(["class A {", "  void m() { new Svc(); new a.b.Repo(1); new Outer.Inner<String>(); }", "}"]);
    expect(one(f, "Svc").recv).toEqual({ kind: "name", name: "Svc", path: [], nesting: null });
    expect(one(f, "Repo").recv).toEqual({ kind: "name", name: "a", path: ["b", "Repo"], nesting: null });
    expect(one(f, "Inner").recv).toEqual({ kind: "name", name: "Outer", path: ["Inner"], nesting: null });
  });

  it("Outer.this.m() has the enclosing instance's type", async () => {
    const f = await factsOf(["class Outer {", "  class Inner {", "    void m() { Outer.this.go(); }", "  }", "}"]);
    expect(one(f, "go").recv).toMatchObject({ kind: "type", type: { name: "Outer", qualifier: null }, path: [] });
  });

  it("anonymous methods own their calls and keep access to captured locals", async () => {
    const f = await factsOf([
      "class A {",
      "  Repo repo;",
      "  void outer(Svc s) {",
      "    exec(new Runnable() {",
      "      public void run() { m(); this.n(); repo.find(); s.typed(); Util.named(); }",
      "    });",
      "  }",
      "  void m() {}",
      "}",
    ]);
    for (const name of ["m", "n"]) {
      expect(one(f, name).recv, name).toEqual({ kind: "self", path: [] });
      expect(callerName(f, one(f, name)), name).toBe("run");
    }
    expect(one(f, "find").recv).toEqual({ kind: "other" });
    expect(one(f, "typed").recv).toMatchObject({ kind: "type", type: { name: "Svc" } });
    expect(one(f, "named").recv).toEqual({ kind: "name", name: "Util", path: [], nesting: null });
    expect(def(f, "run")).toMatchObject({ owner: "A.$1", kind: "method" });
    expect(def(f, "$1")).toMatchObject({ owner: "A", kind: "class", bases: [{ name: "Runnable", qualifier: null }] });
    expect(one(f, "Runnable").recv).toEqual({ kind: "name", name: "Runnable", path: [], nesting: null });
  });

  it("a local class owns its methods under its declaring scope", async () => {
    const f = await factsOf(["class A {", "  void outer() {", "    class Local { void run() { helper(); } }", "  }", "}"]);
    expect(def(f, "Local")).toMatchObject({ owner: "A.outer", kind: "class", topLevel: false });
    expect(one(f, "helper").recv).toEqual({ kind: "self", path: [] });
    expect(callerName(f, one(f, "helper"))).toBe("run");
  });

  it("keeps a local class and its members under the same owner when a line is inserted above its block", async () => {
    const source = [
      "class Host {",
      "  void first() {",
      "    {",
      "      class Local {",
      "        Local() {}",
      "        void run() {}",
      "        void work() {}",
      "      }",
      "    }",
      "  }",
      "}",
    ];
    const before = await factsOf(source);
    const after = await factsOf([...source.slice(0, 2), "    int added = 1;", ...source.slice(2)]);
    const localBefore = before.defs.find((d) => d.name === "Local" && d.kind === "class")!;
    const localAfter = after.defs.find((d) => d.name === "Local" && d.kind === "class")!;
    expect(localBefore.owner).toBe("Host.first");
    expect(localAfter.owner).toBe(localBefore.owner);
    const members = (f: FileFacts) => f.defs.filter((d) => d.kind === "method" && d.owner?.endsWith(".Local"));
    expect(members(before).map((d) => [d.name, d.owner])).toEqual([
      ["Local", "Host.first.Local"],
      ["run", "Host.first.Local"],
      ["work", "Host.first.Local"],
    ]);
    expect(members(after).map((d) => [d.name, d.owner])).toEqual(members(before).map((d) => [d.name, d.owner]));
    expect(stableKey(symbolId("Host.java", localAfter))).toBe(stableKey(symbolId("Host.java", localBefore)));
  });

  it("gives two same-named local classes in one method distinct owners", async () => {
    const f = await factsOf([
      "class Host {",
      "  void blocks() {",
      "    { class Local { void run() { first(); } } }",
      "    { class Other {} class Local { void run() { second(); } } }",
      "  }",
      "}",
    ]);
    expect(f.defs.filter((d) => d.name === "Local").map((d) => d.owner)).toEqual(["Host.blocks", "Host.blocks$2"]);
    expect(f.defs.filter((d) => d.name === "run").map((d) => d.owner)).toEqual(["Host.blocks.Local", "Host.blocks$2.Local"]);
    expect(f.defs[one(f, "first").caller]?.owner).toBe("Host.blocks.Local");
    expect(f.defs[one(f, "second").caller]?.owner).toBe("Host.blocks$2.Local");
  });

  it("a lambda's calls belong to the enclosing method", async () => {
    const f = await factsOf(["class A {", "  void outer() {", "    list.forEach(x -> { helper(); this.other(); });", "  }", "}"]);
    expect(callerName(f, one(f, "helper"))).toBe("outer");
    expect(one(f, "helper").recv).toEqual({ kind: "self", path: [] });
    expect(one(f, "other").recv).toEqual({ kind: "self", path: [] });
    expect(f.defs.map((d) => d.name).sort()).toEqual(["A", "outer"]);
  });

  it("a method reference is a value ref with its receiver", async () => {
    const f = await factsOf([
      "class A {",
      "  void m(Svc s) {",
      "    register(Worker::run);",
      "    list.forEach(this::handle);",
      "    Runnable r = s::go;",
      "  }",
      "}",
    ]);
    const register = f.calls.indexOf(one(f, "register"));
    const forEach = f.calls.indexOf(one(f, "forEach"));
    const byName = (n: string) => f.values.find((v) => v.name === n);
    expect(byName("run")).toMatchObject({ recv: { kind: "name", name: "Worker", path: [], nesting: null }, role: "arg", call: register, arg: 0, line: 3 });
    expect(byName("handle")).toMatchObject({ recv: { kind: "self", path: [] }, role: "arg", call: forEach, arg: 0 });
    expect(byName("go")).toMatchObject({ recv: { kind: "type", type: { name: "Svc", declared: true }, path: [] }, role: "assign" });
    expect(f.values.every((v) => f.defs[v.caller]?.name === "m")).toBe(true);
  });

  it("a method called on a parameter adds the parameter to invokes", async () => {
    const f = await factsOf(["class A {", "  void register(String name, Runnable r) { r.run(); }", "  void other(Runnable r) { r = null; r.run(); }", "}"]);
    expect(def(f, "register").invokes).toEqual([1]);
    // A parameter given another value no longer holds what the caller passed.
    expect(def(f, "other").invokes).toBeUndefined();
  });

  it("nested types carry their owner path", async () => {
    const f = await factsOf(["public class Outer {", "  public static class Inner {", "    interface Deep { void m(); }", "  }", "  enum E { X; void z() {} }", "}"]);
    expect(def(f, "Outer")).toMatchObject({ owner: null, topLevel: true });
    expect(def(f, "Inner")).toMatchObject({ kind: "class", owner: "Outer", topLevel: false, exported: true });
    expect(def(f, "Deep")).toMatchObject({ kind: "class", owner: "Outer.Inner", topLevel: false, iface: true });
    expect(def(f, "m")).toMatchObject({ owner: "Outer.Inner.Deep", abstract: true });
    expect(def(f, "z")).toMatchObject({ owner: "Outer.E" });
  });

  it("type uses include generic arguments and the class of a new without a declared constructor", async () => {
    const f = await factsOf([
      "class A extends B implements I {",
      "  Map<Key, Val> map;",
      "  <T> Ret m(Par p, T t) {",
      "    List<Loc> xs = null;",
      "    Object o = (Cast) p;",
      "    if (o instanceof Test) {}",
      "    new Made();",
      "    return null;",
      "  }",
      "}",
    ]);
    const used = new Set(f.types.map((t) => t.ref.name));
    for (const n of ["B", "I", "Map", "Key", "Val", "Ret", "Par", "List", "Loc", "Object", "Cast", "Test", "Made"]) expect(used.has(n), n).toBe(true);
    // A type parameter names no type.
    expect(used.has("T")).toBe(false);
    const made = f.types.find((t) => t.ref.name === "Made");
    expect(f.defs[made?.caller ?? -1]?.name).toBe("m");
  });

  it("cached anonymous-body flags reject non-boolean values", async () => {
    const f = await factsOf([
      "class Host { Object task = new Object() { void run() {} }; }",
      "enum Choice { FIRST { void run() {} }; abstract void run(); }",
    ]);
    for (const name of ["$1", "FIRST"]) {
      expect(def(f, name)).toMatchObject({ anonymous: true });
      const plain = JSON.parse(JSON.stringify(f));
      expect(isFileFacts(plain)).toBe(true);
      plain.defs.find((d: DefFact) => d.name === name).anonymous = "true";
      expect(isFileFacts(plain)).toBe(false);
    }
  });

  it("safe-fs accepts the new fields and rejects a wrong type for each", async () => {
    const f = await factsOf([
      "package a.b;",
      "import static a.b.Util.helper;",
      "import static a.b.Util.*;",
      "class A {",
      "  A() {}",
      "  void fmt(Object... rest) { helper(1); }",
      "}",
    ]);
    const plain = JSON.parse(JSON.stringify(f)) as FileFacts;
    expect(isFileFacts(plain)).toBe(true);
    const ctorAt = plain.defs.findIndex((d) => d.ctor);
    const varargsAt = plain.defs.findIndex((d) => d.varargs);
    const callAt = plain.calls.findIndex((c) => c.arity !== undefined);
    const memberAt = plain.imports.findIndex((i) => i.staticMember !== undefined);
    const starAt = plain.imports.findIndex((i) => i.staticStar !== undefined);
    expect([ctorAt, varargsAt, callAt, memberAt, starAt].every((i) => i >= 0)).toBe(true);
    const broken: ((x: Record<string, any>) => void)[] = [
      (x) => (x.javaPackage = 7),
      (x) => (x.calls[callAt].arity = "2"),
      (x) => (x.calls[callAt].arity = -1),
      (x) => (x.defs[ctorAt].ctor = "yes"),
      (x) => (x.defs[varargsAt].varargs = 1),
      (x) => (x.imports[memberAt].staticMember = 3),
      (x) => (x.imports[starAt].staticStar = "true"),
    ];
    for (const breakIt of broken) {
      const copy = JSON.parse(JSON.stringify(plain)) as Record<string, any>;
      breakIt(copy);
      expect(isFileFacts(copy), breakIt.toString()).toBe(false);
    }
  });
});
