// Two kinds of give-up the core readers made in silence now reach the
// caller floors as gaps (gap.ts). Ways it could fail, written before the
// code:
//  1. A call on a line the parser could not read (a syntax error) is not
//     in the graph, the build says ok, and the callers answer of what it
//     calls says it is whole: in any of the seven grammars.
//  2. The parser's recovery leaves the callee outside the region it could
//     not read (`Target3(` in Go reads `Target3` as a value before it), so
//     a gap that names only the region's own words misses it.
//     A comment between them hides the neighbour the same way, and the
//     words of a comment (which holds no call) are kept as names.
//     A key in a string there is copied into the cached facts.
//  3. One syntax error floors answers it cannot reach: a function whose
//     name is written nowhere near the region.
//  4. The facts of a file with such a region do not read back from the
//     cache, so every build reads the file again.
//  5. A method found by a name given at run time (Java `getMethod`, Go
//     `MethodByName`, Python `getattr`, Ruby `send`) is called with no
//     caller and no floor; a servlet's own `getMethod()` floors every
//     answer; a key given as the name is kept in the facts as a call name
//     (Ruby `send("sk_live_...")` too).
//  6. The floor says "1 call named `target` could not be bound" when what
//     hides the call is a syntax error or reflection, so the reader does
//     not know where to look or why.
//  7. A key in a string the parser could not close (`"sk_live_...` with
//     no closing quote) is read as code, and its text becomes a region's
//     names, cached and copied into the review packet; for Python the
//     quote is a string's opener and was passed over as text.
//  8. A call in a region names the target under another name the file
//     binds (`import { target as t }`, a default import, a namespace
//     indexed), so no word of the region names it.
//  9. A region inside a function is no gap of that function, so its
//     callees answer reads as whole.
// 10. Nested regions are read once per region around them: a file of
//     2,000 nested broken functions takes tens of seconds.
// 11. A splat gives getattr its name (`getattr(*pair, "x")`), and the
//     gap names the wrong method or none; `getMethods()` on a value
//     declared of another type (`service.getMethods()`) or the class's own
//     method floors every Java answer.
//
// The cases, and the test that holds each:
// | give-up | languages | recorded | reaches | test |
// | call lost in a region | all 7 | file-not-parsed gap at the region | its words and its neighbours', and a call through a value | (1), corpus unread-* |
// | callee left in a neighbour | all | the neighbour's words | as above | (2) |
// | comment, string text | all | no word of them | - | (2) |
// | key-shaped run, unmatched quote | all | no names | every definition of the project | (7) |
// | over 4,096 words | all | no names | every definition of the project | corpus cap-unread-names |
// | a name bound to another | all (imports) | extra gaps | the bound ids, or the module's file | (8) |
// | region inside a definition | all | gap with that caller | callees floor | (9) |
// | unrelated function | TS, JS | - | stays whole | (3) |
// | getMethod/getDeclaredMethod("x") | Java | call `x`, byName | name x | (5) |
// | getMethod(n), getMethods() | Java | computed call, byName | values | (5), (11) |
// | findVirtual/findStatic/findSpecial | Java | as getMethod, name second | name or values | (5) |
// | receiver declared not Class/Lookup, own method | Java | nothing | - | (11) |
// | getMethod() with no argument | Java | nothing | - | (5) |
// | MethodByName("x") / (n) | Go | call `x` / computed, byName | name / values | (5) |
// | getattr(o, "x") / (o, n) / splat | Python | call `x` / computed / computed | name / values | (5), (11) |
// | send/public_send/method(:x), ("x"), (n) | Ruby | call `x` / computed | name / values | (5) |
// | a key as the name | all four | computed call, key not kept | values | (5) |
// | reason wording | all | - | says region or reflection | (1), (5) |
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { extract } from "../src/extract.js";
import { NEXT } from "../src/gap.js";
import { parserFor } from "../src/parser.js";
import { query } from "../src/query/engine.js";
import type { Answer, Request } from "../src/query/answer.js";
import { isFileFacts } from "../src/safe-fs.js";
import { LOOSE_BOUND_MS, cpuMs, expectLinear, growthTests } from "../src/test-timing.js";
import { unreadRegions } from "../src/walk.js";
import { makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const build = (files: Record<string, string>) => buildGraph({ repoRoot: makeRepo(files), store: null });
const callers = (graph: Graph, name: string, file: string): Answer => query({ graph, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false }, { apiVersion: 1, kind: "callers", target: { name, file } } as Request);
const GO_MOD = "module m\n\ngo 1.21\n";
const KEY = `sk_live_${"0a1b2c3d".repeat(4)}`;
const TS_BAD = 'import { target } from "./lib";\nexport function a() { return target(); }\nexport function c( { target(); }\n';

// Each grammar: the target, a file whose call of it the parser cannot read, and the region's line.
const BROKEN: [string, Record<string, string>, string, string, string, number][] = [
  ["typescript", { "lib.ts": "export function target(): number { return 1; }\n", "bad.ts": TS_BAD }, "target", "lib.ts", "bad.ts", 3],
  ["tsx", { "lib.tsx": "export function target() { return 1; }\n", "bad.tsx": TS_BAD }, "target", "lib.tsx", "bad.tsx", 3],
  ["javascript", { "lib.js": "export function target() { return 1; }\n", "bad.js": TS_BAD.replace('"./lib"', '"./lib.js"') }, "target", "lib.js", "bad.js", 3],
  ["python", { "lib.py": "def target():\n    return 1\n", "bad.py": "from lib import target\n\ndef c(:\n    target(\n\ndef d():\n    return 2\n" }, "target", "lib.py", "bad.py", 4],
  ["go", { "go.mod": GO_MOD, "lib.go": "package main\n\nfunc Target3() int { return 1 }\n", "bad.go": "package main\n\nfunc run() { defer Target3(; }\n" }, "Target3", "lib.go", "bad.go", 3],
  ["java", { "D.java": "class D { static void target4() {} }\n", "E.java": "class E { void run() { int x = D.target4(; } }\n" }, "target4", "D.java", "E.java", 1],
  ["ruby", { "w.rb": "class W\n  def target2; 1; end\nend\n", "b.rb": "class X\n  def run(w)\n    w.target2(\n  end\nend\n" }, "target2", "w.rb", "b.rb", 1],
];

describe("a region the parser could not read is a gap", () => {
  it.each(BROKEN)("floors the callers of a function its call may run, in %s (1)", async (_lang, files, name, file, bad, line) => {
    const graph = await build(files);
    const a = callers(graph, name, file);
    expect(a.error).toBeNull();
    expect(a.unknown.floor).toBe(true);
    const gaps = (a.unknown.gaps ?? []).filter((g) => g.cause === "file-not-parsed");
    expect(gaps).toContainEqual({ cause: "file-not-parsed", file: bad, line, next: NEXT.unread });
    // The reason says a region the parser could not read names it (6).
    expect(a.unknown.reasons.join(" ")).toContain(`1 region of code the parser could not read (a syntax error) names \`${name}\`, first at ${bad}:${line}`);
  }, 60_000);

  it("names the callee the recovery left outside the region (2)", async () => {
    const graph = await build({ "go.mod": GO_MOD, "lib.go": "package main\n\nfunc Target3() int { return 1 }\n", "bad.go": "package main\n\nfunc run() { x := Target3( ; _ = x }\n" });
    const gap = graph.unknowns.find((u) => u.cause === "file-not-parsed" && u.file === "bad.go");
    expect(gap?.reaches).toEqual({ names: expect.arrayContaining(["Target3"]) });
    expect(gap?.scope).toBe("project");
  }, 60_000);

  it("passes over a comment to the neighbour, and keeps no word of a comment (2)", async () => {
    const parser = await parserFor("go");
    const tree = parser.parse("package main\n\nfunc run() {\n\tx := Target3 /* why not */ ( ; _ = x\n}\n");
    if (!tree) throw new Error("no tree");
    const names = extract(tree, "go").unread?.flatMap((r) => r.names ?? []) ?? [];
    expect(names).toContain("Target3");
    expect(names).not.toContain("why");
  });

  it("keeps no word of a string's text, where a key may be (2)", async () => {
    const parser = await parserFor("python");
    const tree = parser.parse(`x = connect("${KEY}", target(\n`);
    if (!tree) throw new Error("no tree");
    const facts = extract(tree, "python");
    expect(facts.unread?.flatMap((r) => r.names ?? [])).toEqual(expect.arrayContaining(["connect", "target"]));
    expect(JSON.stringify(facts)).not.toContain(KEY);
  });

  it("leaves the floor of a function named nowhere near the region (3)", async () => {
    const graph = await build({ "lib.ts": "export function target(): number { return 1; }\nexport function other(): number { return 2; }\n", "bad.ts": TS_BAD });
    const a = callers(graph, "other", "lib.ts");
    expect(a.unknown.floor).toBe(false);
    expect(a.unknown.gaps ?? []).toEqual([]);
  }, 60_000);

  it("keeps the regions in facts that read back from the cache (4)", async () => {
    const parser = await parserFor("typescript");
    const tree = parser.parse(TS_BAD);
    if (!tree) throw new Error("no tree");
    const facts = extract(tree, "typescript");
    expect(facts.unread).toEqual([{ line: 3, column: 0, names: expect.arrayContaining(["c", "target"]) }]);
    expect(isFileFacts(JSON.parse(JSON.stringify(facts)))).toBe(true);
    // A file the parser reads whole keeps none.
    const clean = parser.parse("export function f() { return 1; }\n");
    if (!clean) throw new Error("no tree");
    expect(extract(clean, "typescript").unread).toBeUndefined();
  });
});

// Each language: a method found by a name given at run time, and what the gap reaches.
const REFLECT: [string, Record<string, string>, string, string, "names" | "values"][] = [
  ["Java getMethod with a literal name", { "D.java": "class D { static void target4() {} }\n", "E.java": 'class E { void run() throws Exception { D.class.getMethod("target4").invoke(null); } }\n' }, "target4", "D.java", "names"],
  ["Java getDeclaredMethod with a name given", { "D.java": "class D { static void target4() {} }\n", "E.java": "class E { void run(String n) throws Exception { D.class.getDeclaredMethod(n).invoke(null); } }\n" }, "target4", "D.java", "values"],
  ["Java getMethods", { "D.java": "class D { static void target4() {} }\n", "E.java": "class E { void run() throws Exception { for (var m : D.class.getMethods()) m.invoke(null); } }\n" }, "target4", "D.java", "values"],
  ["Go MethodByName with a literal name", { "go.mod": GO_MOD, "lib.go": "package main\n\ntype T struct{}\n\nfunc (T) Target3() int { return 1 }\n", "r.go": 'package main\n\nimport "reflect"\n\nfunc run() { reflect.ValueOf(T{}).MethodByName("Target3").Call(nil) }\n' }, "Target3", "lib.go", "names"],
  ["Go MethodByName with a name given", { "go.mod": GO_MOD, "lib.go": "package main\n\ntype T struct{}\n\nfunc (T) Target3() int { return 1 }\n", "r.go": 'package main\n\nimport "reflect"\n\nfunc run(n string) { reflect.ValueOf(T{}).MethodByName(n).Call(nil) }\n' }, "Target3", "lib.go", "values"],
  ["Python getattr with a literal name", { "a.py": "def target():\n    return 1\n", "b.py": 'import a\n\ndef register(f):\n    return f\n\ndef go():\n    register(getattr(a, "target"))\n' }, "target", "a.py", "names"],
  ["Python getattr with a name given", { "a.py": "def target():\n    return 1\n", "b.py": "import a\n\ndef register(f):\n    return f\n\ndef go(name):\n    register(getattr(a, name))\n" }, "target", "a.py", "values"],
  ["Java findVirtual with a literal name", { "D.java": "class D { void target4() {} }\n", "E.java": 'import java.lang.invoke.MethodHandles;\nclass E { void run() throws Exception { MethodHandles.lookup().findVirtual(D.class, "target4", null); } }\n' }, "target4", "D.java", "names"],
  ["Java findStatic with a name given, on a Lookup local", { "D.java": "class D { static void target4() {} }\n", "E.java": "import java.lang.invoke.MethodHandles;\nclass E { void run(String n) throws Exception { MethodHandles.Lookup l = MethodHandles.lookup(); l.findStatic(D.class, n, null); } }\n" }, "target4", "D.java", "values"],
  ["Java getMethods on a Class parameter", { "D.java": "class D { static void target4() {} }\n", "E.java": "class E { void run(Class<?> c) throws Exception { for (var m : c.getMethods()) m.invoke(null); } }\n" }, "target4", "D.java", "values"],
  ["Python getattr given its name by a splat", { "a.py": "def target():\n    return 1\n", "b.py": 'import a\n\ndef register(f):\n    return f\n\ndef go(pair):\n    register(getattr(*pair, "fallback"))\n' }, "target", "a.py", "values"],
  ["Ruby method with a symbol", { "b.rb": "class W\n  def target2; 1; end\nend\nclass V\n  def run(w); w.method(:target2).call; end\nend\n" }, "target2", "b.rb", "names"],
  // Ruby's reader already made these calls (rbNamedCalls): kept here so they stay.
  ["Ruby public_send with a symbol", { "b.rb": "class W\n  def target2; 1; end\nend\nclass V\n  def run(w); w.public_send(:target2); end\nend\n" }, "target2", "b.rb", "names"],
  ["Ruby send with a name given", { "b.rb": "class W\n  def target2; 1; end\n  def run(n); send(n); end\nend\n" }, "target2", "b.rb", "values"],
];

describe("a call by a name built at run time is a gap", () => {
  it.each(REFLECT)("floors the callers of the method it may find: %s (5)", async (_label, files, name, file, reach) => {
    const graph = await build(files);
    const a = callers(graph, name, file);
    expect(a.error).toBeNull();
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.gaps ?? []).toContainEqual(expect.objectContaining({ next: NEXT.byName }));
    // The reason says the method is found by a name given at run time, not only that a call is unbound (6).
    expect(a.unknown.reasons.join(" ")).toMatch(reach === "names" ? new RegExp(`1 call finds \`${name}\` by a name given at run time \\(reflection\\), first at `) : /of them, 1 finds a method by a name given at run time \(reflection\)/);
    const reached = graph.unknowns.filter((u) => (reach === "names" ? typeof u.reaches === "object" && "names" in u.reaches && u.reaches.names.includes(name) : u.reaches === "values"));
    expect(reached.length).toBe(1);
  }, 60_000);

  it("reads a key given as the name as a name it does not know, and keeps it nowhere (5)", async () => {
    const parser = await parserFor("python");
    const tree = parser.parse(`import settings\n\ndef go():\n    return getattr(settings, "${KEY}", None)\n`);
    if (!tree) throw new Error("no tree");
    const facts = extract(tree, "python");
    expect(facts.calls.some((c) => c.dynamic)).toBe(true);
    expect(JSON.stringify(facts)).not.toContain(KEY);
  });

  it("reads a key given to Ruby's send as a name it does not know, and keeps it nowhere (5)", async () => {
    const parser = await parserFor("ruby");
    const tree = parser.parse(`class W\n  def go(o)\n    o.send("${KEY}")\n    o.public_send("save!")\n  end\nend\n`);
    if (!tree) throw new Error("no tree");
    const facts = extract(tree, "ruby");
    expect(JSON.stringify(facts)).not.toContain(KEY);
    expect(facts.calls.filter((c) => c.byName).map((c) => c.name)).toEqual(["", "save!"]);
  });

  it("leaves a servlet's own getMethod() alone (5)", async () => {
    const graph = await build({ "D.java": "class D { static void target4() {} }\n", "E.java": "class E { String run(Req req) { return req.getMethod(); } }\ninterface Req { String getMethod(); }\n" });
    const a = callers(graph, "target4", "D.java");
    expect(a.unknown.floor).toBe(false);
    expect(graph.unknowns.filter((u) => u.reaches === "values")).toEqual([]);
  }, 60_000);
});

describe("a call by a name built at run time is read only where it can be one", () => {
  const javaCalls = async (src: string) => extract((await parserFor("java")).parse(src) ?? (() => { throw new Error("no tree"); })(), "java").calls;

  it("records getMethods only on a value that may be a Class (11)", async () => {
    const calls = await javaCalls(
      "class Service { java.util.List<String> getMethods() { return null; } }\nclass A {\n  Service svc;\n  Class<?> k;\n  void f(Object o, Class<?> c, Service s) {\n    s.getMethods();\n    svc.getMethods();\n    getMethods();\n    this.getMethods();\n    c.getMethods();\n    k.getMethods();\n    o.getClass().getMethods();\n    A.class.getMethods();\n  }\n  java.util.List<String> getMethods() { return null; }\n}\n",
    );
    expect(calls.filter((c) => c.byName).map((c) => c.line)).toEqual([10, 11, 12, 13]);
  });

  it("records a MethodHandles lookup only on a value that may be a Lookup (11)", async () => {
    const calls = await javaCalls('class Router { void findVirtual(int a, String b, int c) {} }\nclass A {\n  void f(Router r, java.lang.invoke.MethodHandles.Lookup l) {\n    r.findVirtual(1, "x", 2);\n    l.findVirtual(A.class, "y", null);\n  }\n}\n');
    expect(calls.filter((c) => c.byName).map((c) => c.name)).toEqual(["y"]);
  });

  it("reads getattr's name as not known when a splat may give it (11)", async () => {
    const tree = (await parserFor("python")).parse('def go(pair, args):\n    getattr(*pair, "fallback")\n    getattr(*args)\n    getattr(o, *rest)\n    getattr(o, "save", *rest)\n');
    if (!tree) throw new Error("no tree");
    const byName = extract(tree, "python").calls.filter((c) => c.byName);
    expect(byName.map((c) => [c.line, c.name, c.dynamic === true])).toEqual([[2, "", true], [3, "", true], [4, "", true], [5, "save", false]]);
  });

  it.each([
    ["java", `class E { void run() throws Exception { D.class.getMethod("${KEY}").invoke(null); } }\n`],
    ["go", `package main\n\nimport "reflect"\n\nfunc run(v reflect.Value) { v.MethodByName("${KEY}").Call(nil) }\n`],
  ])("reads a key given as the name in %s as a name it does not know, and keeps it nowhere (5)", async (lang, src) => {
    const tree = (await parserFor(lang as "go")).parse(src);
    if (!tree) throw new Error("no tree");
    const facts = extract(tree, lang as "go");
    expect(facts.calls.some((c) => c.byName && c.dynamic)).toBe(true);
    expect(JSON.stringify(facts)).not.toContain(KEY);
  });
});

describe("a region the parser could not read reaches what its names are bound to", () => {
  it.each([
    ["a renamed import", "export function target(): number { return 1; }\n", 'import { target as t } from "./lib";\nexport function go() {\n  return { a: t( };\n}\n'],
    ["a default import", "export default function target(): number { return 1; }\n", 'import t from "./lib";\nexport function go() {\n  return { a: t( };\n}\n'],
    ["a namespace indexed", "export function target(): number { return 1; }\n", 'import * as ns from "./lib";\nexport function go(k: string) {\n  return { a: (ns as any)[k]( };\n}\n'],
  ])("floors the target called through %s in a region (8)", async (_label, lib, bad) => {
    const graph = await build({ "lib.ts": lib, "bad.ts": bad });
    const a = callers(graph, "target", "lib.ts");
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.gaps ?? []).toContainEqual({ cause: "file-not-parsed", file: "bad.ts", line: 3, next: NEXT.unread });
  }, 60_000);

  it("says the callees of a function holding a region may be missing (9)", async () => {
    const graph = await build({ "lib.ts": "export function target(): number { return 1; }\n", "bad.ts": 'import { target } from "./lib";\nexport function go() {\n  const x = 1;\n  return { a: target( };\n}\n' });
    const a = query({ graph, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false }, { apiVersion: 1, kind: "callees", target: { name: "go", file: "bad.ts" } } as Request);
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.gaps ?? []).toContainEqual({ cause: "file-not-parsed", file: "bad.ts", line: 4, next: NEXT.unread });
  }, 60_000);

  it("reads a file of 2,000 nested broken functions in well under a second of CPU (10)", async () => {
    const src = Array.from({ length: 2000 }, (_, i) => `function f${i}() { x = = ; `).join("") + "}".repeat(2000);
    const tree = (await parserFor("typescript")).parse(src);
    if (!tree) throw new Error("no tree");
    const before = process.cpuUsage();
    const regions = unreadRegions(tree);
    const used = process.cpuUsage(before);
    expect(regions.length).toBe(1);
    // Read once per region around it, this took about 40 seconds.
    expect((used.user + used.system) / 1000).toBeLessThan(LOOSE_BOUND_MS);
  }, 120_000);

  it("keeps no word after a Python string opener the parser left unmatched (7)", async () => {
    const tree = (await parserFor("python")).parse('def f():\n    return 1\nk = "my private words\nfoo()\n');
    if (!tree) throw new Error("no tree");
    const unread = extract(tree, "python").unread ?? [];
    expect(unread.length).toBeGreaterThan(0);
    expect(JSON.stringify(unread)).not.toContain("private");
    expect(unread.every((r) => r.names === null)).toBe(true);
  });
});

growthTests("reading regions grows with the code, not with the regions around it (10)", () => {
  it("reads 4,000 nested broken functions in less than eight times the CPU of 1,000", async () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `function f${i}() { x = = ; `).join("") + "}".repeat(n);
    const parser = await parserFor("typescript");
    const small = parser.parse(make(1000));
    const large = parser.parse(make(4000));
    if (!small || !large) throw new Error("no tree");
    expectLinear("regions of 1,000 and of 4,000 nested broken functions", await cpuMs(() => unreadRegions(small)), await cpuMs(() => unreadRegions(large)));
  }, 600_000);
});

// A key-shaped token in a string the parser could not close, in each
// family and each kind of quote: `sk_live_` and `sk-live-` forms, the
// secret part starting with a letter so no word of it is a cut of it.
const HEX = "a0b1c2d3".repeat(4);
const UNCLOSED: Record<string, { quotes: string[]; make: (q: string, k: string) => string }> = {
  typescript: { quotes: ['"', "'", "`"], make: (q, k) => `export function f() { return 1; }\nconst k = ${q}${k}\nfoo();\n` },
  python: { quotes: ['"', "'", '"""'], make: (q, k) => `def f():\n    return 1\nk = ${q}${k}\nfoo()\n` },
  go: { quotes: ['"', "'", "`"], make: (q, k) => `package main\nfunc f() int { return 1 }\nvar k = ${q}${k}\nfunc g() { foo() }\n` },
  ruby: { quotes: ['"', "'", "`"], make: (q, k) => `def f; 1; end\nk = ${q}${k}\nfoo\n` },
  java: { quotes: ['"', "'", '"""'], make: (q, k) => `class A { int f() { return 1; } String k = ${q}${k}; void g() { foo(); } }\n` },
};
const UNCLOSED_CASES = Object.entries(UNCLOSED).flatMap(([lang, c]) => c.quotes.flatMap((q) => [`sk_live_${HEX}`, `sk-live-${HEX}`].map((k): [string, string, string] => [lang, q, k])));

describe("a key in a string the parser could not close is kept nowhere in a region", () => {
  it.each(UNCLOSED_CASES)("%s, quote %s, %s (7)", async (lang, q, key) => {
    const parser = await parserFor(lang as "typescript");
    const tree = parser.parse((UNCLOSED[lang] as (typeof UNCLOSED)[string]).make(q, key));
    if (!tree) throw new Error("no tree");
    const unread = extract(tree, lang as "typescript").unread ?? [];
    expect(unread.length).toBeGreaterThan(0);
    expect(JSON.stringify(unread)).not.toContain(HEX);
    // What was dropped may name a call: such a region may hide a call of anything.
    expect(unread.some((r) => r.names === null)).toBe(true);
  });

  it("keeps the words of a region with no quote left open and no key", async () => {
    const parser = await parserFor("typescript");
    const tree = parser.parse('const k = "plain text";\nexport function c( { target(); }\n');
    if (!tree) throw new Error("no tree");
    const unread = extract(tree, "typescript").unread ?? [];
    expect(unread.flatMap((r) => r.names ?? ["<null>"])).toEqual(expect.arrayContaining(["c", "target"]));
  });
});
