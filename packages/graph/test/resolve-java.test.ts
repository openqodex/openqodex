// Java resolution rules the corpus cannot isolate, each on a small real
// repository built in a temp folder and parsed by the real extractor:
// 1. The tie rule: a main source binds a test copy of a class, or one
//    qualified name declared in two other projects binds certain.
// 2. The arity rule: a varargs member is not counted as fitting, a call
//    whose argument list did not parse narrows to one member, or a call
//    dispatches to an implementation of another overload.
// 3. A static star import does not bind a bare call.
// 4. new T() on a class without a declared constructor leaves a miss.
// 5. Type::instanceMethod is not a use of the method.
// 6. The ext rule: a package of a declared dependency group (pom.xml or
//    Gradle) is a gap, or a package nothing declares is called external.
// 7. An override edge joins members with different parameter counts, or a
//    static method.
// 8. The model loses the Java projects and dependency groups through a
//    saved index, or a build file is not a manifest of the change.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, deserializeModel, isManifest, isTestPath, serializeModel } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { gradleGroups, pomGroups } from "../src/discovery/projects.js";
import { at, callSites, makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

async function graphOf(files: Record<string, string>): Promise<Graph> {
  return buildGraph({ repoRoot: makeRepo(files), store: null });
}

const lines = (...l: string[]) => `${l.join("\n")}\n`;

// The tier of every calls site into `id`, as "path:line tier".
function tiers(graph: Graph, id: string, kind = "calls"): string[] {
  return (graph.in.get(id) ?? [])
    .filter((e) => e.kind === kind)
    .flatMap((e) => e.sites.map((s) => `${s.file}:${s.line} ${s.tier}`))
    .sort();
}

const unknownsAt = (graph: Graph, site: string) => graph.unknowns.filter((u) => `${u.file}:${u.line}` === site);

describe("java callable aliases and anonymous member classes", () => {
  it("names the receiver local in the alias note when a callable held in a local is invoked through it", async () => {
    const files = {
      "Host.java": lines(
        "class Host {",
        "  void work() {}",
        "  void use() {",
        "    Runnable r = this::work;",
        "    r.run(); // CALL",
        "  }",
        "}",
      ),
      "run.py": lines("def work():", "    pass", "", "def use():", "    callback = work", "    callback()"),
    };
    const g = await graphOf(files);
    const sites = (id: string) => (g.in.get(id) ?? []).filter((e) => e.kind === "may_invoke").flatMap((e) => e.sites);
    const receiver = sites(symbol(g, "Host.java", "work", "Host"));
    expect(receiver).toHaveLength(1);
    expect(`${receiver[0]?.file}:${receiver[0]?.line}`).toBe(at(files, "Host.java", "CALL"));
    expect(receiver[0]?.note).toMatch(/^r is given/);
    const bare = sites(symbol(g, "run.py", "work"));
    expect(bare).toHaveLength(1);
    expect(bare[0]?.note).toMatch(/^callback is given/);
  });

  it("binds a bare type name to the package class, not to a member class of an anonymous class", async () => {
    const files = {
      "A.java": lines(
        "package p;",
        "class Host {",
        "  Runnable r = new Runnable() {",
        "    class Inner { void go() {} }",
        "    public void run() {}",
        "  };",
        "  void use() { new Inner().go(); } // CALL",
        "}",
        "class Outside extends Inner {",
        "  void use() { go(); } // INHERITED",
        "}",
      ),
      "B.java": lines("package p;", "class Inner { void go() {} }"),
    };
    const g = await graphOf(files);
    expect(callSites(g, symbol(g, "B.java", "go", "Inner"))).toEqual([at(files, "A.java", "CALL"), at(files, "A.java", "INHERITED")].sort());
    expect(callSites(g, symbol(g, "A.java", "go", "Host.$1.Inner"))).toEqual([]);
  });
});

describe("java result candidates", () => {
  const candidates = (other: string) => ({
    "A.java": lines(
      "class Repo { void find() {} }",
      "class Other { void find() {} }",
      "class Box<T> { T get() { return null; } }",
      "class A {",
      "  Box<Repo> make(Repo ignored) { return null; }",
      `  Box<${other}> make(Other ignored) { return null; }`,
      "}",
      "class Use {",
      "  void go(A a) { a.make(null).get().find(); } // CHAIN",
      "}",
    ),
  });

  it("leaves a chained call unresolved when result candidates carry different type arguments", async () => {
    const files = candidates("Other");
    const g = await graphOf(files);
    const site = at(files, "A.java", "CHAIN");
    const make = (g.defsByFile.get("A.java") ?? []).filter((d) => d.name === "make");
    expect(make).toHaveLength(2);
    for (const d of make) expect(tiers(g, d.id)).toEqual([`${site} possible`]);
    expect(callSites(g, symbol(g, "A.java", "find", "Repo"))).not.toContain(site);
    expect(callSites(g, symbol(g, "A.java", "find", "Other"))).not.toContain(site);
    expect(unknownsAt(g, site).some((u) => u.name === "find")).toBe(true);
  });

  it("resolves a chained call when result candidates carry identical type arguments at different positions", async () => {
    const files = candidates("Repo");
    const g = await graphOf(files);
    const site = at(files, "A.java", "CHAIN");
    const make = (g.defsByFile.get("A.java") ?? []).filter((d) => d.name === "make");
    expect(make).toHaveLength(2);
    for (const d of make) expect(tiers(g, d.id)).toEqual([`${site} possible`]);
    expect(callSites(g, symbol(g, "A.java", "find", "Repo"))).toEqual([site]);
    expect(callSites(g, symbol(g, "A.java", "find", "Other"))).toEqual([]);
  });
});

describe("java result candidates across classes", () => {
  // Failure: an override that returns the same generic type as the method it
  // overrides is a second candidate with another owner; comparing owners or
  // files instead of the resolved arguments drops a certain chain.
  it("resolves a chained call when an override in another file returns the same type arguments", async () => {
    const files = {
      "Repo.java": lines("class Repo { void find() {} }", "class Box<T> { T get() { return null; } }"),
      "A.java": lines("class A {", "  Box<Repo> make() { return null; }", "}"),
      "B.java": lines("class B extends A {", "  Box<Repo> make() { return null; }", "}"),
      "Use.java": lines("class Use {", "  void go(B b) { b.make().get().find(); } // CHAIN", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "Use.java", "CHAIN");
    const makes = [...(g.defsByFile.get("A.java") ?? []), ...(g.defsByFile.get("B.java") ?? [])].filter((d) => d.name === "make");
    expect(makes).toHaveLength(2);
    expect(callSites(g, symbol(g, "Repo.java", "find", "Repo"))).toEqual([site]);
  });
});

describe("java result candidates with external arguments", () => {
  // Failure: an argument the graph cannot follow (a dependency type) must cost
  // only the argument, never the container's own methods.
  it("keeps a container method certain when an override returns the same container with an external argument", async () => {
    const files = {
      "Box.java": lines("class Box<T> { int size() { return 0; } T get() { return null; } }"),
      "A.java": lines("class A {", "  Box<String> make() { return null; }", "}"),
      "B.java": lines("class B extends A {", "  Box<String> make() { return null; }", "}"),
      "Use.java": lines("class Use {", "  void go(B b) { b.make().size(); } // SIZE", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "Use.java", "SIZE");
    expect(callSites(g, symbol(g, "Box.java", "size", "Box"))).toEqual([site]);
    expect(unknownsAt(g, site).some((u) => u.name === "size")).toBe(false);
  });
});

describe("java tie rule", () => {
  const util = (n: number) => lines("package a.b;", "", "public class Util {", "    public static int v() {", `        return ${n};`, "    }", "}");
  const caller = (cls: string) => lines("package app;", "", "import a.b.Util;", "", `public class ${cls} {`, "    int go() {", "        return Util.v(); // CALL", "    }", "}");

  it("never binds a main source to a test copy of the class it imports", async () => {
    const files = {
      "pom.xml": "<project/>\n",
      "src/test/java/a/b/Util.java": util(2),
      "src/main/java/app/Main.java": caller("Main"),
    };
    const g = await graphOf(files);
    expect(tiers(g, symbol(g, "src/test/java/a/b/Util.java", "v", "Util"))).toEqual([]);
  });

  it("binds a test source to the test copy of its own project before the main copy", async () => {
    const files = {
      "pom.xml": "<project/>\n",
      "src/main/java/a/b/Util.java": util(1),
      "src/test/java/a/b/Util.java": util(2),
      "src/test/java/app/MainTest.java": caller("MainTest"),
    };
    const g = await graphOf(files);
    const site = at(files, "src/test/java/app/MainTest.java", "CALL");
    expect(tiers(g, symbol(g, "src/test/java/a/b/Util.java", "v", "Util"))).toEqual([`${site} certain`]);
    expect(tiers(g, symbol(g, "src/main/java/a/b/Util.java", "v", "Util"))).toEqual([]);
  });

  it("leaves a class declared in two other projects as an ambiguous gap, never a certain edge", async () => {
    const files = {
      "one/pom.xml": "<project/>\n",
      "two/pom.xml": "<project/>\n",
      "one/src/main/java/a/b/Util.java": util(1),
      "two/src/main/java/a/b/Util.java": util(2),
      "app/src/main/java/app/Main.java": caller("Main"),
      "app/pom.xml": "<project/>\n",
    };
    const g = await graphOf(files);
    const site = at(files, "app/src/main/java/app/Main.java", "CALL");
    expect(tiers(g, symbol(g, "one/src/main/java/a/b/Util.java", "v", "Util"))).toEqual([]);
    expect(tiers(g, symbol(g, "two/src/main/java/a/b/Util.java", "v", "Util"))).toEqual([]);
    expect(unknownsAt(g, site).map((u) => u.cause)).toEqual(["ambiguous"]);
  });
});

describe("java arity rule", () => {
  const fmt = lines(
    "package f;",
    "",
    "public class Fmt {",
    "    public static String fmt(String s) {",
    "        return s;",
    "    }",
    "",
    "    public static String fmt(String s, Object... rest) {",
    "        return s + rest.length;",
    "    }",
    "}",
  );

  it("counts a varargs member as fitting from its fixed parameters up", async () => {
    const files = {
      "f/Fmt.java": fmt,
      "f/Use.java": lines("package f;", "", "public class Use {", "    void go() {", '        Fmt.fmt("a"); // ONE', '        Fmt.fmt("a", 1, 2); // THREE', "    }", "}"),
    };
    const g = await graphOf(files);
    const plain = g.defsByFile.get("f/Fmt.java")?.find((n) => n.name === "fmt" && n.startLine === 4)?.id as string;
    const varargs = g.defsByFile.get("f/Fmt.java")?.find((n) => n.name === "fmt" && n.startLine === 8)?.id as string;
    expect(tiers(g, plain)).toEqual([`${at(files, "f/Use.java", "ONE")} possible`]);
    expect(tiers(g, varargs)).toEqual([`${at(files, "f/Use.java", "ONE")} possible`, `${at(files, "f/Use.java", "THREE")} certain`].sort());
  });

  it("keeps every member as possible when the argument list did not parse", async () => {
    const files = {
      "f/Fmt.java": fmt,
      "f/Use.java": lines("package f;", "", "public class Use {", "    void go() {", '        Fmt.fmt("a", +); // BROKEN', "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "f/Use.java", "BROKEN");
    const fmts = (g.defsByFile.get("f/Fmt.java") ?? []).filter((n) => n.name === "fmt");
    expect(fmts.length).toBe(2);
    expect(fmts.some((n) => tiers(g, n.id).some((t) => t.startsWith(site)))).toBe(true);
    for (const n of fmts) expect(tiers(g, n.id).filter((t) => t.startsWith(site)).every((t) => t.endsWith("possible"))).toBe(true);
  });

  it("dispatches a call only to implementations whose parameter count fits", async () => {
    const files = {
      "r/Runner.java": lines("package r;", "", "public interface Runner {", "    void run();", "", "    void run(int n);", "}"),
      "r/Impl.java": lines("package r;", "", "public class Impl implements Runner {", "    public void run() {", "    }", "", "    public void run(int n) {", "    }", "}"),
      "r/Use.java": lines("package r;", "", "public class Use {", "    void go(Runner x) {", "        x.run(1); // ONE", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "r/Use.java", "ONE");
    const noArgs = g.defsByFile.get("r/Impl.java")?.find((n) => n.name === "run" && n.startLine === 4)?.id as string;
    const oneArg = g.defsByFile.get("r/Impl.java")?.find((n) => n.name === "run" && n.startLine === 7)?.id as string;
    expect(tiers(g, oneArg, "dispatches_to")).toEqual([`${site} possible`]);
    expect(tiers(g, noArgs, "dispatches_to")).toEqual([]);
  });

  it("joins an override only to the base member with the same parameter count, and never a static method", async () => {
    const files = {
      "r/Base.java": lines("package r;", "", "public class Base {", "    public void run() {", "    }", "", "    public void run(int n) {", "    }", "", "    public static void make() {", "    }", "}"),
      "r/Sub.java": lines("package r;", "", "public class Sub extends Base {", "    public void run(int n) {", "    }", "", "    public static void make() {", "    }", "}"),
    };
    const g = await graphOf(files);
    const overrides = (from: string) => (g.refsOut.get(from) ?? []).filter((e) => e.kind === "overrides").map((e) => g.nodes.get(e.to)?.startLine);
    expect(overrides(symbol(g, "r/Sub.java", "run", "Sub"))).toEqual([7]);
    expect(overrides(symbol(g, "r/Sub.java", "make", "Sub"))).toEqual([]);
  });
});

describe("java imports and values", () => {
  it("binds a bare call through a static star import", async () => {
    const files = {
      "a/b/Util.java": lines("package a.b;", "", "public class Util {", "    public static int helper() {", "        return 1;", "    }", "}"),
      "c/App.java": lines("package c;", "", "import static a.b.Util.*;", "", "public class App {", "    int go() {", "        return helper(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    expect(tiers(g, symbol(g, "a/b/Util.java", "helper", "Util"))).toEqual([`${at(files, "c/App.java", "CALL")} certain`]);
  });

  it("records new T() of a class without a declared constructor as a type use, with no miss and no unknown", async () => {
    const files = {
      "p/Plain.java": lines("package p;", "", "public class Plain {", "}"),
      "p/Make.java": lines("package p;", "", "public class Make {", "    Object go() {", "        return new Plain(); // NEW", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "p/Make.java", "NEW");
    const plain = symbol(g, "p/Plain.java", "Plain");
    expect((g.refsIn.get(plain) ?? []).filter((e) => e.kind === "uses_type").flatMap((e) => e.sites.map((s) => `${s.file}:${s.line}`))).toEqual([site]);
    expect(callSites(g, plain)).toEqual([]);
    expect(unknownsAt(g, site)).toEqual([]);
    expect(g.misses.filter((m) => `${m.site.file}:${m.site.line}` === site)).toEqual([]);
  });

  it("records Type::instanceMethod as a use of the instance method", async () => {
    const files = {
      "w/Worker.java": lines("package w;", "", "public class Worker {", "    public String name() {", '        return "w";', "    }", "}"),
      "w/Use.java": lines("package w;", "", "import java.util.function.Function;", "", "public class Use {", "    Function<Worker, String> pick() {", "        return Worker::name; // REF", "    }", "}"),
    };
    const g = await graphOf(files);
    const name = symbol(g, "w/Worker.java", "name", "Worker");
    expect((g.refsIn.get(name) ?? []).filter((e) => e.kind === "uses_value").flatMap((e) => e.sites.map((s) => `${s.file}:${s.line}`))).toEqual([at(files, "w/Use.java", "REF")]);
  });

  it("calls a package of a declared dependency group external and discloses a package nothing declares as a miss", async () => {
    const files = {
      "pom.xml": lines("<project>", "  <dependencies>", "    <dependency>", "      <groupId>com.google.guava</groupId>", "      <artifactId>guava</artifactId>", "    </dependency>", "  </dependencies>", "</project>"),
      "lib/build.gradle": lines("dependencies {", '    implementation("org.apache.commons:commons-lang3:3.14.0")', "}"),
      "src/App.java": lines(
        "package app;",
        "",
        "import com.google.guava.Strings;",
        "import org.apache.commons.lang3.StringUtils;",
        "import net.other.Thing;",
        "",
        "public class App {",
        "    void go() {",
        '        Strings.isNullOrEmpty("a"); // MAVEN',
        '        StringUtils.trim("a"); // GRADLE',
        "        Thing.make(); // MISS",
        "    }",
        "}",
      ),
    };
    const g = await graphOf(files);
    expect(unknownsAt(g, at(files, "src/App.java", "MAVEN"))).toEqual([]);
    expect(unknownsAt(g, at(files, "src/App.java", "GRADLE"))).toEqual([]);
    expect(g.status.externalSites).toBeGreaterThanOrEqual(2);
    const miss = unknownsAt(g, at(files, "src/App.java", "MISS"));
    expect(miss.map((u) => [u.cause, u.note])).toEqual([["miss", "the package net.other is not in the repository and no build file declares a dependency for it"]]);
    expect(g.status.status).toBe("ok");
  });
});

describe("java project model", () => {
  it("reads dependency groups from pom.xml dependencies and Gradle coordinates, and skips a property group", () => {
    expect(pomGroups("<project><groupId>me</groupId><dependencies><dependency><groupId>org.slf4j</groupId></dependency><dependency><groupId>${g}</groupId></dependency></dependencies></project>")).toEqual(["org.slf4j"]);
    expect(gradleGroups("implementation 'com.squareup.okhttp3:okhttp:4.12.0'\napi(\"io.netty:netty-all\")\nprintln \"a: b\"\n")).toEqual(["com.squareup.okhttp3", "io.netty"]);
  });

  it("never takes a groupId for a pom.xml dependency that has none from the next dependency", () => {
    expect(pomGroups("<dependencies><dependency><artifactId>x</artifactId></dependency><dependency><groupId>org.next</groupId></dependency></dependencies>")).toEqual(["org.next"]);
  });

  it("reads a long single-line Gradle file of many quotes to its end", () => {
    const line = `${'"a" '.repeat(100_000)}implementation 'org.end:lib:1.0' ${"'".repeat(1)}`;
    expect(gradleGroups(line)).toEqual(["org.end"]);
  });

  it("keeps the Java projects and dependency groups through a saved index, and reads an older one without them", async () => {
    const g = await graphOf({ "svc/pom.xml": "<project><dependencies><dependency><groupId>org.slf4j</groupId></dependency></dependencies></project>\n", "svc/A.java": "package a;\nclass A {}\n" });
    expect(g.model.javaProjects).toEqual(["svc"]);
    const kept = deserializeModel(JSON.parse(JSON.stringify(serializeModel(g.model))) as Record<string, unknown>);
    expect(kept.javaProjects).toEqual(["svc"]);
    expect([...kept.javaDeps]).toEqual(["org.slf4j"]);
    const old = serializeModel(g.model) as Record<string, unknown>;
    delete old.javaProjects;
    delete old.javaDeps;
    const restored = deserializeModel(old);
    expect(restored.javaProjects).toEqual([]);
    expect([...restored.javaDeps]).toEqual([]);
  });

  it("counts Maven and Gradle files as manifests of a change and a JUnit class file as a test", () => {
    for (const f of ["pom.xml", "a/build.gradle", "a/build.gradle.kts", "settings.gradle", "settings.gradle.kts"]) expect(isManifest(f)).toBe(true);
    expect(isTestPath("src/main/java/a/FooTest.java")).toBe(true);
    expect(isTestPath("src/main/java/a/FooIT.java")).toBe(true);
    expect(isTestPath("src/main/java/a/Foo.java")).toBe(false);
  });
});

// Findings of the review of the final diff, one test each.
describe("java review findings", () => {
  const ids = (g: Graph, file: string, name: string) => (g.defsByFile.get(file) ?? []).filter((n) => n.name === name).map((n) => n.id);
  const siteTiers = (g: Graph, file: string, name: string, site: string, kind = "calls") => ids(g, file, name).flatMap((id) => tiers(g, id, kind).filter((t) => t.startsWith(`${site} `)));

  it("1. never drops an abstract overload for a body member of the same class with the same parameter count", async () => {
    const files = {
      "a/A.java": lines("package a;", "", "public abstract class A {", "    abstract void m(String s);", "", "    void m(Integer i) {", "    }", "}"),
      "a/U.java": lines("package a;", "", "public class U {", "    void go(A a) {", '        a.m("x"); // CALL', "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "a/U.java", "CALL");
    expect(siteTiers(g, "a/A.java", "m", site).sort()).toEqual([`${site} possible`, `${site} possible`]);
  });

  it("2. keeps a static overload of the class as a candidate of a bare call in an instance method", async () => {
    const files = { "a/C.java": lines("package a;", "", "public class C {", "    void f(Object o) {", "    }", "", "    static void f(String s) {", "    }", "", "    void g() {", '        f("x"); // CALL', "    }", "}") };
    const g = await graphOf(files);
    const site = at(files, "a/C.java", "CALL");
    expect(siteTiers(g, "a/C.java", "f", site).sort()).toEqual([`${site} possible`, `${site} possible`]);
  });

  it("3. never binds new C() to a static method named C or to a base class's constructor", async () => {
    const files = {
      "a/B.java": lines("package a;", "", "public class B {", "    public B() {", "    }", "}"),
      "a/C.java": lines("package a;", "", "public class C extends B {", "    static C C() {", "        return null;", "    }", "}"),
      "a/U.java": lines("package a;", "", "public class U {", "    Object go() {", "        return new C(); // NEW", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "a/U.java", "NEW");
    expect(siteTiers(g, "a/B.java", "B", site)).toEqual([]);
    expect(siteTiers(g, "a/C.java", "C", site)).toEqual([]);
  });

  it("4. reads a main source named like a test by its folder, so it never binds the test copy", async () => {
    const util = (n: number) => lines("package a.b;", "", "public class Util {", "    public static int v() {", `        return ${n};`, "    }", "}");
    const files = {
      "pom.xml": "<project/>\n",
      "src/main/java/a/b/Util.java": util(1),
      "src/test/java/a/b/Util.java": util(2),
      "src/main/java/app/SmokeTest.java": lines("package app;", "", "import a.b.Util;", "", "public class SmokeTest {", "    int go() {", "        return Util.v(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "src/main/java/app/SmokeTest.java", "CALL");
    expect(siteTiers(g, "src/main/java/a/b/Util.java", "v", site)).toEqual([`${site} certain`]);
    expect(siteTiers(g, "src/test/java/a/b/Util.java", "v", site)).toEqual([]);
  });

  const varargs = {
    "a/Base.java": lines("package a;", "", "public class Base {", "    void f(String... xs) {", "    }", "}"),
    "a/Pair.java": lines("package a;", "", "public class Pair extends Base {", "    void f(String a, String b) {", "    }", "}"),
    "a/Arr.java": lines("package a;", "", "public class Arr extends Base {", "    void f(String[] xs) {", "    }", "}"),
    "a/U.java": lines("package a;", "", "public class U {", "    void go(Base b) {", '        b.f("a", "b"); // CALL', "    }", "}"),
  };

  it("5. dispatches by the bound member's parameter count, with T... and T[] the same, never by the call's argument count", async () => {
    const g = await graphOf(varargs);
    const site = at(varargs, "a/U.java", "CALL");
    expect(siteTiers(g, "a/Arr.java", "f", site, "dispatches_to")).toEqual([`${site} possible`]);
    expect(siteTiers(g, "a/Pair.java", "f", site, "dispatches_to")).toEqual([]);
  });

  it("6. joins f(String[]) as an override of f(String...)", async () => {
    const g = await graphOf(varargs);
    const out = (g.refsOut.get(symbol(g, "a/Arr.java", "f", "Arr")) ?? []).filter((e) => e.kind === "overrides").map((e) => e.to);
    expect(out).toEqual([symbol(g, "a/Base.java", "f", "Base")]);
  });

  it("7. binds a member likely, never certain, when a base outside the graph may declare a better overload", async () => {
    const files = {
      "a/L.java": lines("package a;", "", "import java.util.ArrayList;", "", "public class L extends ArrayList<String> {", "    public boolean add(String s) {", "        return true;", "    }", "}"),
      "a/U.java": lines("package a;", "", "public class U {", "    void go(L l) {", '        l.add("x"); // CALL', "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "a/U.java", "CALL");
    expect(siteTiers(g, "a/L.java", "add", site)).toEqual([`${site} likely`]);
  });

  it("8. leaves a call no member's parameter count fits as an unknown, with no edge", async () => {
    const files = {
      "a/C.java": lines("package a;", "", "public class C {", "    void m(int a) {", "    }", "}"),
      "a/U.java": lines("package a;", "", "public class U {", "    void go(C c) {", "        c.m(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "a/U.java", "CALL");
    expect(siteTiers(g, "a/C.java", "m", site)).toEqual([]);
    expect(unknownsAt(g, site).map((u) => u.note)).toEqual(["no member named m takes 0 arguments; a member outside the graph may"]);
  });

  it("9. binds this(...) to the class's own constructor and super(...) to the superclass's", async () => {
    const files = {
      "a/B.java": lines("package a;", "", "public class B {", "    public B(int x) {", "    }", "}"),
      "a/C.java": lines("package a;", "", "public class C extends B {", "    public C() {", "        super(1); // SUPER", "    }", "", "    public C(String s) {", "        this(); // THIS", "    }", "}"),
    };
    const g = await graphOf(files);
    const sup = at(files, "a/C.java", "SUPER");
    const own = at(files, "a/C.java", "THIS");
    expect(siteTiers(g, "a/B.java", "B", sup)).toEqual([`${sup} certain`]);
    const noArgs = (g.defsByFile.get("a/C.java") ?? []).find((n) => n.name === "C" && n.startLine === 4)?.id as string;
    expect(tiers(g, noArgs)).toEqual([`${own} certain`]);
  });

  it("11. combines every static import of one member name before the arity rule", async () => {
    const files = {
      "a/A.java": lines("package a;", "", "public class A {", "    public static void f(int x) {", "    }", "}"),
      "a/B.java": lines("package a;", "", "public class B {", "    public static void f(String x) {", "    }", "}"),
      "c/U.java": lines("package c;", "", "import static a.B.f;", "import static a.A.f;", "", "public class U {", "    void go() {", "        f(1); // CALL", "    }", "}"),
      "c/V.java": lines("package c;", "", "import static a.A.*;", "import static a.B.*;", "", "public class V {", "    void go() {", "        f(1); // STAR", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "c/U.java", "CALL");
    const star = at(files, "c/V.java", "STAR");
    expect(siteTiers(g, "a/A.java", "f", site)).toEqual([`${site} possible`]);
    expect(siteTiers(g, "a/B.java", "f", site)).toEqual([`${site} possible`]);
    expect(siteTiers(g, "a/A.java", "f", star)).toEqual([`${star} possible`]);
    expect(siteTiers(g, "a/B.java", "f", star)).toEqual([`${star} possible`]);
  });

  it("12. never reads a superclass field for a field of the subclass whose type is not a class", async () => {
    const files = {
      "a/Repo.java": lines("package a;", "", "public class Repo {", "    public void find() {", "    }", "}"),
      "a/Base.java": lines("package a;", "", "public class Base {", "    Repo r;", "}"),
      "a/Child.java": lines("package a;", "", "public class Child<T> extends Base {", "    T r;", "", "    void m() {", "        r.find(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "a/Child.java", "CALL");
    expect(siteTiers(g, "a/Repo.java", "find", site)).toEqual([]);
    expect(unknownsAt(g, site).length).toBe(1);
  });

  it("13. finds a nested type inherited from a superclass before a same-named type of the package", async () => {
    const files = {
      "p/Outer.java": lines("package p;", "", "public class Outer {", "    public static class Inner {", "        public static void run() {", "        }", "    }", "}"),
      "p/Inner.java": lines("package p;", "", "public class Inner {", "    public static void run() {", "    }", "}"),
      "p/Child.java": lines("package p;", "", "public class Child extends Outer {", "    void go() {", "        Inner.run(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "p/Child.java", "CALL");
    expect(siteTiers(g, "p/Outer.java", "run", site)).toEqual([`${site} certain`]);
    expect(siteTiers(g, "p/Inner.java", "run", site)).toEqual([]);
  });

  it("14. reads an array dimension written after a parameter's name, so a call on it is the array's", async () => {
    const files = {
      "a/Foo.java": lines("package a;", "", "public class Foo {", "    public Object clone() {", "        return null;", "    }", "}"),
      "a/U.java": lines("package a;", "", "public class U {", "    Object go(Foo xs[]) {", "        return xs.clone(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    expect(siteTiers(g, "a/Foo.java", "clone", at(files, "a/U.java", "CALL"))).toEqual([]);
  });

  it("15. binds the one member of a call whose argument list did not parse as possible", async () => {
    const files = {
      "a/F.java": lines("package a;", "", "public class F {", "    public static void fmt(String s) {", "    }", "}"),
      "a/U.java": lines("package a;", "", "public class U {", "    void go() {", '        F.fmt("a", +); // BROKEN', "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "a/U.java", "BROKEN");
    expect(siteTiers(g, "a/F.java", "fmt", site)).toEqual([`${site} possible`]);
  });

  it("16. never reads a dependency group from a commented-out pom.xml dependency or Gradle line", () => {
    expect(pomGroups("<dependencies><!-- <dependency><groupId>com.acme</groupId></dependency> --><dependency><groupId>org.real</groupId></dependency></dependencies>")).toEqual(["org.real"]);
    expect(gradleGroups("  // implementation('com.acme:lib:1')\n/* api 'com.block:lib:1'\n testImplementation 'com.block2:x:1' */\nimplementation 'org.real:lib:1'\n")).toEqual(["org.real"]);
  });
});

// Findings of the second review of the fix diff, one test each.
describe("java second review findings", () => {
  const ids = (g: Graph, file: string, name: string) => (g.defsByFile.get(file) ?? []).filter((n) => n.name === name).map((n) => n.id);
  const siteTiers = (g: Graph, file: string, name: string, site: string, kind = "calls") => ids(g, file, name).flatMap((id) => tiers(g, id, kind).filter((t) => t.startsWith(`${site} `)));

  it("r1. keeps an abstract member nearer to the receiver than a body member of the same parameter count", async () => {
    const files = {
      "a/B.java": lines("package a;", "", "public class B {", "    void f(Object x) {", "    }", "}"),
      "a/C.java": lines("package a;", "", "public abstract class C extends B {", "    abstract void f(String x);", "}"),
      "a/U.java": lines("package a;", "", "public class U {", "    void go(C c) {", '        c.f("x"); // CALL', "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "a/U.java", "CALL");
    expect(siteTiers(g, "a/C.java", "f", site)).toEqual([`${site} possible`]);
    expect(siteTiers(g, "a/B.java", "f", site)).toEqual([`${site} possible`]);
  });

  it("r2. never reads a pattern variable after a negated guard as the field of that name", async () => {
    const files = {
      "a/Foo.java": lines("package a;", "", "public class Foo {", "    public void run() {", "    }", "}"),
      "a/U.java": lines("package a;", "", "public class U {", "    Foo x;", "", "    void m(Object o) {", "        if (!(o instanceof Bar x)) return;", "        x.run(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    expect(siteTiers(g, "a/Foo.java", "run", at(files, "a/U.java", "CALL"))).toEqual([]);
  });

  it("r3. never makes a constructor a candidate of an ordinary call named like the class", async () => {
    const files = { "a/C.java": lines("package a;", "", "public class C {", "    C() {", "    }", "", "    void C() {", "    }", "", "    void g() {", "        C(); // CALL", "    }", "}") };
    const g = await graphOf(files);
    const site = at(files, "a/C.java", "CALL");
    expect(siteTiers(g, "a/C.java", "C", site)).toEqual([`${site} certain`]);
    const method = (g.defsByFile.get("a/C.java") ?? []).find((n) => n.name === "C" && n.startLine === 7)?.id as string;
    expect(tiers(g, method)).toEqual([`${site} certain`]);
  });

  it("r4. never dispatches a bare call whose only fitting candidate is static", async () => {
    const files = {
      "a/Base.java": lines("package a;", "", "public class Base {", "    static void f(String s) {", "    }", "", "    void f(int a, int b) {", "    }", "", "    void g() {", '        f("x"); // CALL', "    }", "}"),
      "a/Sub.java": lines("package a;", "", "public class Sub extends Base {", "    void f(Object o) {", "    }", "}"),
    };
    const g = await graphOf(files);
    expect(siteTiers(g, "a/Sub.java", "f", at(files, "a/Base.java", "CALL"), "dispatches_to")).toEqual([]);
  });

  it("r5. leaves super(...) to a superclass nothing declares as an unknown, never external", async () => {
    const files = { "a/C.java": lines("package a;", "", "import missing.Base;", "", "public class C extends Base {", "    C() {", "        super(1); // CALL", "    }", "}") };
    const g = await graphOf(files);
    expect(unknownsAt(g, at(files, "a/C.java", "CALL")).map((u) => u.cause)).toEqual(["no-receiver-type"]);
  });

  it("r6. binds a repository static import possible when another static import of the name is external", async () => {
    const files = {
      "a/A.java": lines("package a;", "", "public class A {", "    public static int abs(Object o) {", "        return 0;", "    }", "}"),
      "c/U.java": lines("package c;", "", "import static java.lang.Math.abs;", "import static a.A.abs;", "", "public class U {", "    int go() {", "        return abs(1); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "c/U.java", "CALL");
    expect(siteTiers(g, "a/A.java", "abs", site)).toEqual([`${site} possible`]);
  });

  it("r7. emits a static-import candidate with its own lowered evidence, never the first import's", async () => {
    const files = {
      "a/A.java": lines("package a;", "", "public class A {", "    public static void f(String s) {", "    }", "}"),
      "a/B.java": lines("package a;", "", "import java.util.ArrayList;", "", "public class B extends ArrayList<String> {", "    public static void f(int a, int b) {", "    }", "}"),
      "c/U.java": lines("package c;", "", "import static a.A.f;", "import static a.B.f;", "", "public class U {", "    void go() {", "        f(1, 2); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "c/U.java", "CALL");
    expect(siteTiers(g, "a/B.java", "f", site)).toEqual([`${site} likely`]);
  });

  it("r8. never opens a block comment inside a quoted Gradle string", () => {
    expect(gradleGroups('exclude("META-INF/*")\nimplementation "org.real:lib:1"\n')).toEqual(["org.real"]);
  });

  it("r9. never reads a dependency from a trailing Gradle comment", () => {
    expect(gradleGroups('println("x") // implementation("com.fake:lib:1")\nimplementation "org.real:lib:1" // ok\n')).toEqual(["org.real"]);
  });

  it("r10. reads a pom groupId split by an XML comment as one name", () => {
    expect(pomGroups("<dependency><groupId>com.<!-- note -->acme</groupId></dependency>")).toEqual(["com.acme"]);
  });
});

// Findings of the dogfood review of the branch, one test each.
describe("java dogfood review findings", () => {
  const ids = (g: Graph, file: string, name: string) => (g.defsByFile.get(file) ?? []).filter((n) => n.name === name).map((n) => n.id);
  const siteTiers = (g: Graph, file: string, name: string, site: string, kind = "calls") => ids(g, file, name).flatMap((id) => tiers(g, id, kind).filter((t) => t.startsWith(`${site} `)));

  it("d1. binds a fully qualified repository type in a file with an external star import", async () => {
    const files = {
      "com/acme/Repo.java": lines("package com.acme;", "", "public class Repo {", "    public static void find() {", "    }", "}"),
      "app/U.java": lines("package app;", "", "import java.util.*;", "", "public class U {", "    void go() {", "        com.acme.Repo.find(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "app/U.java", "CALL");
    expect(siteTiers(g, "com/acme/Repo.java", "find", site)).toEqual([`${site} certain`]);
  });

  it("d3. keeps a var local's type when it is given what a call on it returns", async () => {
    const files = {
      "a/B.java": lines("package a;", "", "public class B {", "    public B with(int x) {", "        return this;", "    }", "}"),
      "a/U.java": lines("package a;", "", "public class U {", "    void go() {", "        var b = new B();", "        b = b.with(1); // CALL", "        b.with(2); // AFTER", "    }", "}"),
    };
    const g = await graphOf(files);
    expect(siteTiers(g, "a/B.java", "with", at(files, "a/U.java", "CALL"))).toEqual([`${at(files, "a/U.java", "CALL")} certain`]);
    expect(siteTiers(g, "a/B.java", "with", at(files, "a/U.java", "AFTER"))).toEqual([`${at(files, "a/U.java", "AFTER")} certain`]);
  });

  it("d4. keeps a reassigned var local at the static type its declaration gave, as javac does", async () => {
    const files = {
      "a/Item.java": lines("package a;", "", "public class Item {", "    public void run() {", "    }", "}"),
      "a/A.java": lines("package a;", "", "public class A {", "    public Item get() {", "        return null;", "    }", "}"),
      "a/B.java": lines("package a;", "", "public class B {", "    public Item get() {", "        return null;", "    }", "}"),
      "a/U.java": lines("package a;", "", "public class U {", "    void go(A a, B b) {", "        var x = a.get();", "        x = b.get();", "        x.run(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "a/U.java", "CALL");
    expect(siteTiers(g, "a/Item.java", "run", site)).toEqual([`${site} certain`]);
  });

  it("d7. reads common java.lang classes without an import as external, never as unknowns", async () => {
    const files = {
      "a/U.java": lines("package a;", "", "public class U {", "    Object go(String s) {", "        Double.parseDouble(s); // DOUBLE", "        Character.isDigit('1'); // CHAR", '        return new IllegalArgumentException("x"); // EXC', "    }", "}"),
    };
    const g = await graphOf(files);
    for (const m of ["DOUBLE", "CHAR", "EXC"]) expect(unknownsAt(g, at(files, "a/U.java", m))).toEqual([]);
  });

  it("d7b. lets a repository class named like a java.lang class win over it", async () => {
    const files = {
      "a/Double.java": lines("package a;", "", "public class Double {", "    public static void parse() {", "    }", "}"),
      "a/U.java": lines("package a;", "", "public class U {", "    void go() {", "        Double.parse(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "a/U.java", "CALL");
    expect(siteTiers(g, "a/Double.java", "parse", site)).toEqual([`${site} certain`]);
  });

  it("d8. binds the nested types a star import of a class brings, with no missing-package gap", async () => {
    const files = {
      "a/b/Outer.java": lines("package a.b;", "", "public class Outer {", "    public static class Inner {", "        public static void run() {", "        }", "    }", "}"),
      "c/U.java": lines("package c;", "", "import a.b.Outer.*;", "", "public class U {", "    void go() {", "        Inner.run(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "c/U.java", "CALL");
    expect(siteTiers(g, "a/b/Outer.java", "run", site)).toEqual([`${site} certain`]);
    expect(g.unknowns.filter((u) => u.file === "c/U.java")).toEqual([]);
  });

  it("d6. reads Maven's test class names as tests, one shape each", () => {
    for (const f of ["a/TestFoo.java", "a/FooTest.java", "a/FooTests.java", "a/FooTestCase.java", "a/FooIT.java", "a/ITFoo.java", "a/FooITCase.java"]) expect(isTestPath(f), f).toBe(true);
    for (const f of ["a/Testament.java", "a/Item.java", "a/Contest.java"]) expect(isTestPath(f), f).toBe(false);
  });
});

// Findings of the second dogfood pass, one test each.
describe("java second dogfood findings", () => {
  const ids = (g: Graph, file: string, name: string) => (g.defsByFile.get(file) ?? []).filter((n) => n.name === name).map((n) => n.id);
  const siteTiers = (g: Graph, file: string, name: string, site: string, kind = "calls") => ids(g, file, name).flatMap((id) => tiers(g, id, kind).filter((t) => t.startsWith(`${site} `)));

  it("e1. reads a package folder named test under src/main as main source, so a main file binds it", async () => {
    const files = {
      "pom.xml": "<project/>\n",
      "src/main/java/com/acme/test/Probe.java": lines("package com.acme.test;", "", "public class Probe {", "    public static void run() {", "    }", "}"),
      "src/main/java/com/acme/app/App.java": lines("package com.acme.app;", "", "import com.acme.test.Probe;", "", "public class App {", "    void go() {", "        Probe.run(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "src/main/java/com/acme/app/App.java", "CALL");
    expect(siteTiers(g, "src/main/java/com/acme/test/Probe.java", "run", site)).toEqual([`${site} certain`]);
  });

  it("e5. binds new R(...) to a record's compact constructor and its body's calls to it", async () => {
    const files = {
      "a/Svc.java": lines("package a;", "", "public class Svc {", "    public void go() {", "    }", "}"),
      "a/R.java": lines("package a;", "", "public record R(int x, Svc s) {", "    public R {", "        s.go(); // BODY", "    }", "}"),
      "a/U.java": lines("package a;", "", "public class U {", "    Object make(Svc s) {", "        return new R(1, s); // NEW", "    }", "}"),
    };
    const g = await graphOf(files);
    const ctor = (g.defsByFile.get("a/R.java") ?? []).find((n) => n.name === "R" && n.kind === "method")?.id as string;
    expect(tiers(g, ctor)).toEqual([`${at(files, "a/U.java", "NEW")} certain`]);
    const go = symbol(g, "a/Svc.java", "go", "Svc");
    expect((g.in.get(go) ?? []).map((e) => e.from)).toEqual([ctor]);
  });

  it("e7. discloses an unresolved import of a file in the default package as a miss", async () => {
    const files = { "U.java": lines("import net.other.Thing;", "", "public class U {", "    void go() {", "        Thing.make(); // CALL", "    }", "}") };
    const g = await graphOf(files);
    expect(unknownsAt(g, at(files, "U.java", "CALL")).map((u) => u.cause)).toEqual(["miss"]);
  });
});
