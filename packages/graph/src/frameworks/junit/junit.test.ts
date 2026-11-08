import { getChange } from "@openqodex/core";
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, detectImpact, extractFacts, frameworkLayer, renderImpactBlock, validateFrameworkEvidence } from "../../index.js";
import { pluginCpuMs, readerCpuMs } from "../../test-timing.js";
import { MAX_ENTITIES_PER_APP } from "../stage.js";
import { MAX_ANNOTATIONS, readFacts } from "./facts.js";
import { junit } from "./index.js";

// These checks need a whole graph or a timed reader, beyond corpus scoring.
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oq-junit-"));
  roots.push(root);
  writeFiles(root, files);
  return root;
}

function commitAll(root: string): void {
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
}
const prod = "src/main/java/shop/Service.java";
const test = "src/test/java/shop/ServiceTest.java";
const pom = "<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>shop</artifactId><version>1</version></project>\n";

describe("the JUnit plugin on a Maven application", () => {
  it("lists both direct tests with their call tiers and excludes helper and unrelated annotation leads", async () => {
    const source = "package shop;\npublic class Service {\n  public int read(String key, Object... rest) { return 1; }\n  public int read(Integer key) { return 2; }\n}\n";
    const root = makeRepo({
      "pom.xml": pom,
      [prod]: source,
      [test]: [
        "package shop;",
        "import org.junit.jupiter.api.Test;",
        "import org.junit.jupiter.api.BeforeEach;",
        "class ServiceTest {",
        "  @Test void direct() { new Service().read(\"a\", \"b\"); }",
        "  @Test void ambiguous(String key) { new Service().read(key); }",
        "  void helper() { new Service().read(\"a\", \"b\"); }",
        "  @Test void indirect() { helper(); }",
        "  @BeforeEach void setup() { new Service().read(\"a\", \"b\"); }",
        "}",
      ].join("\n"),
      "src/test/java/other/annotations/Test.java": "package other.annotations; public @interface Test {}\n",
      "src/test/java/shop/AmbiguousTest.java": "package shop;\nimport org.junit.jupiter.api.*;\nimport other.annotations.*;\nclass AmbiguousTest { @Test void uncertain() { new Service().read(\"a\", \"b\"); } }\n",
      "src/test/java/other/UnrelatedTest.java": "package other;\nimport org.testng.annotations.Test;\nimport shop.Service;\nclass UnrelatedTest { @Test void unrelated() { new Service().read(\"a\", \"b\"); } }\n",
    });
    commitAll(root);
    writeFiles(root, { [prod]: source.replace("return 1;", "return 3;") });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const graph = await buildGraph({ repoRoot: root, store: null });
    const target = (graph.defsByFile.get(prod) ?? []).find((n) => n.kind === "method" && n.startLine === 3);
    expect(target).toBeDefined();
    const links = graph.frameworks?.edges.filter((e) => e.plugin === "junit" && e.kind === "tests" && e.to === target?.id) ?? [];
    expect(links.map((e) => [graph.nodes.get(e.from)?.name, e.evidence.tier, e.category]).sort()).toEqual([
      ["ambiguous", "possible", "direct-call"],
      ["direct", "certain", "direct-call"],
    ]);
    expect(frameworkLayer(graph)?.testsOf(target?.id ?? "")).toHaveLength(2);
    const roles = graph.frameworks?.roles.filter((r) => r.plugin === "junit") ?? [];
    expect(roles.every((r) => graph.nodes.get(r.target)?.kind === "method")).toBe(true);
    expect(roles.find((r) => graph.nodes.get(r.target)?.name === "setup")?.role).toBe("fixture");
    expect(graph.frameworks?.apps.filter((a) => a.plugin === "junit")).toHaveLength(1);
    const proof = roles.find((r) => graph.nodes.get(r.target)?.name === "direct")?.evidence;
    expect(proof).toMatchObject({ kind: "role-decorator", tier: "certain", site: { file: test, line: 5 }, via: { file: test, line: 2, spec: "org.junit.jupiter.api.Test" } });
    for (const record of [...roles, ...links]) expect(validateFrameworkEvidence(record.evidence)).toBeNull();
    const gap = graph.frameworks?.unknowns.find((u) => u.plugin === "junit" && u.cause === "ambiguous");
    expect(gap).toMatchObject({ scope: { file: "src/test/java/shop/AmbiguousTest.java" }, affects: ["tests"] });
    const brief = renderImpactBlock(detectImpact(graph, change));
    const rows = brief.split("\n").filter((line) => line.startsWith("| ") && line.includes("| calls |"));
    expect(rows).toHaveLength(2);
    expect(rows.find((line) => line.includes("ServiceTest.direct"))).toContain("certain");
    expect(rows.find((line) => line.includes("ServiceTest.ambiguous"))).toContain("possible");
    for (const name of ["ServiceTest.indirect", "ServiceTest.helper", "AmbiguousTest.uncertain", "UnrelatedTest.unrelated"]) expect(rows.join("\n")).not.toContain(name);
    console.log("JUnit sample: 2 direct links, 2 brief rows, tiers certain and possible.");
  });
});

describe("the JUnit plugin on hostile input", () => {
  it("keeps 1999 roles and a cap gap when a near 1 MiB file exceeds the default file limit", async () => {
    const head = "package shop;\nimport org.junit.jupiter.api.Test;\nclass Hostile {\n";
    const methods = Array.from({ length: MAX_ANNOTATIONS + 100 }, (_, i) => `  @Test void t${i}() {}\n`).join("");
    const body = `${head}${methods}}\n`;
    const source = body + "//" + "x".repeat(1024 * 1024 - body.length - 3);
    expect(Buffer.byteLength(source)).toBe(1024 * 1024 - 1);
    expect(junit.wants(source, "java")).toBe(true);
    const facts = await extractFacts("java", source);
    const annotations = facts?.frameworks?.junit?.filter((f) => f.kind === "annotation") ?? [];
    expect(annotations).toHaveLength(MAX_ANNOTATIONS);
    expect(annotations[0]).toMatchObject({ name: "Test", owner: "Hostile", method: { name: "t0", line: 4, column: 14 } });
    expect(annotations[annotations.length - 1]).toMatchObject({ name: "Test", method: { name: "t1998" } });
    expect(facts?.frameworks?.junit?.filter((f) => f.kind === "cap")).toHaveLength(1);
    const root = makeRepo({ "pom.xml": pom, "src/test/java/shop/Hostile.java": source });
    commitAll(root);
    const skipped = await buildGraph({ repoRoot: root, store: null });
    expect(skipped.status.notRead).toContainEqual({ file: "src/test/java/shop/Hostile.java", reason: "size" });
    const build = () => buildGraph({ repoRoot: root, store: null, maxFileBytes: 1024 * 1024, budgetMs: 120_000 });
    const graph = await build();
    expect(graph.status.notRead).toEqual([]);
    const readMs = await readerCpuMs("java", [source], readFacts);
    const resolveMs = await pluginCpuMs(build, "junit");
    expect(readMs + resolveMs).toBeLessThan(1000);
    expect(graph.frameworks?.roles.filter((r) => r.plugin === "junit")).toHaveLength(MAX_ANNOTATIONS);
    expect(graph.frameworks?.edges.filter((e) => e.plugin === "junit")).toHaveLength(0);
    expect(graph.frameworks?.unknowns.filter((u) => u.plugin === "junit")).toEqual([
      expect.objectContaining({ cause: "fan-out-capped", scope: { file: "src/test/java/shop/Hostile.java" }, affects: ["tests"] }),
    ]);
    console.log(`JUnit hostile: ${Buffer.byteLength(source)} bytes, ${annotations.length} annotation facts, ${MAX_ANNOTATIONS} roles, 0 edges, 1 gap, ${(readMs + resolveMs).toFixed(1)} ms.`);
  }, 120_000);
});


describe("JUnit review regressions", () => {
  it("keeps a second project's roles and test edges after the first project fills its role cap", async () => {
    const files: Record<string, string> = {
      "a/pom.xml": pom,
      "z/pom.xml": pom,
      "z/src/main/java/shop/Service.java": "package shop; public class Service { public void read() {} }\n",
      "z/src/test/java/shop/LastTest.java": "package shop; import org.junit.jupiter.api.Test; class LastTest { @Test void reads() { new Service().read(); } }\n",
    };
    const total = MAX_ENTITIES_PER_APP + 1;
    for (let start = 0; start < total; start += 1000) {
      const name = `First${start}`;
      const methods = Array.from({ length: Math.min(1000, total - start) }, (_, i) => `@Test void t${start + i}() {}`).join("\n");
      files[`a/src/test/java/first/${name}.java`] = `package first; import org.junit.jupiter.api.Test; class ${name} {\n${methods}\n}\n`;
    }
    const root = makeRepo(files);
    commitAll(root);
    const graph = await buildGraph({ repoRoot: root, store: null, budgetMs: 120_000 });
    const data = graph.frameworks;
    const first = data?.apps.find((a) => a.plugin === "junit" && a.project === "a");
    const last = data?.apps.find((a) => a.plugin === "junit" && a.project === "z");
    expect(last).toBeDefined();
    expect(data?.roles.filter((r) => r.plugin === "junit" && r.app === last?.id)).toHaveLength(1);
    expect(data?.edges.filter((e) => e.plugin === "junit" && e.app === last?.id && e.kind === "tests")).toHaveLength(1);
    expect(data?.roles.filter((r) => r.plugin === "junit" && r.app === first?.id)).toHaveLength(MAX_ENTITIES_PER_APP);
    expect(data?.unknowns.filter((u) => u.plugin === "junit")).toEqual([
      expect.objectContaining({ cause: "fan-out-capped", scope: { app: first?.id }, affects: ["tests"] }),
    ]);
    console.log(`JUnit application cap: ${total} roles offered to the first project, ${MAX_ENTITIES_PER_APP} kept; second project keeps 1 role and 1 test edge.`);
  }, 120_000);

  it("keeps all test roles when unrelated annotations would exhaust the file fact cap", async () => {
    const methods = Array.from({ length: 1000 }, (_, i) => `  @Test @DisplayName("case") @Tag("unit") void t${i}() {}`).join("\n");
    const source = `package shop;\nimport org.junit.jupiter.api.*;\nclass Decorated {\n${methods}\n}\n`;
    const root = makeRepo({ "pom.xml": pom, "src/test/java/shop/Decorated.java": source });
    commitAll(root);
    const graph = await buildGraph({ repoRoot: root, store: null });
    expect(graph.frameworks?.roles.filter((r) => r.plugin === "junit")).toHaveLength(1000);
    expect(graph.frameworks?.unknowns.filter((u) => u.plugin === "junit")).toEqual([]);
    const facts = await extractFacts("java", source);
    expect(facts?.frameworks?.junit).toHaveLength(1000);
    expect(facts?.frameworks?.junit?.every((f) => f.kind === "annotation" && "name" in f && f.name === "Test")).toBe(true);
    console.log("JUnit annotation filter: 3000 annotations in, 1000 facts and roles out, 0 gaps.");
  });

  it("keeps test roles when indexing 8000 small Java files would exhaust the resolution budget", async () => {
    const files: Record<string, string> = { "pom.xml": pom };
    const methods = Array.from({ length: 24 }, (_, i) => `  void m${i}() {}`).join("\n");
    for (let i = 0; i < 8000; i++) files[`src/main/java/plain/Plain${i}.java`] = `package plain;\nimport java.util.List;\nclass Plain${i} {\n${methods}\n}\n`;
    files[test] = "package shop;\nimport org.junit.jupiter.api.Test;\nclass ServiceTest { @Test void reads() {} }\n";
    const root = makeRepo(files);
    commitAll(root);
    const graph = await buildGraph({ repoRoot: root, store: null, maxFiles: 9000, budgetMs: 120_000, maxHeapMb: 2048 });
    expect(graph.status.notRead).toEqual([]);
    expect(graph.status.filesParsed).toBe(8001);
    expect(graph.frameworks?.roles.filter((r) => r.plugin === "junit")).toHaveLength(1);
    expect(graph.frameworks?.unknowns.filter((u) => u.plugin === "junit")).toEqual([]);
    console.log("JUnit linear indexing: 8001 Java files in, 1 test role out, 0 gaps.");
  }, 180_000);

  it("rebinds unchanged test facts when the metadata corpus deletes only a shadowing annotation", async () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../corpus/frameworks/junit/junit-metadata-edit");
    const shadow = "src/test/java/shop/Test.java";
    expect(existsSync(join(fixture, "base", shadow))).toBe(true);
    expect(existsSync(join(fixture, "change", test))).toBe(false);
    expect(readFileSync(join(fixture, "delete.txt"), "utf8").trim()).toBe(shadow);
    const files = Object.fromEntries(["pom.xml", prod, test, shadow].map((path) => [path, readFileSync(join(fixture, "base", path), "utf8")]));
    const root = makeRepo(files);
    commitAll(root);
    const before = await buildGraph({ repoRoot: root, store: null });
    expect(before.frameworks?.roles.filter((r) => r.plugin === "junit")).toEqual([]);
    if (existsSync(join(fixture, "change"))) cpSync(join(fixture, "change"), root, { recursive: true, force: true });
    rmSync(join(root, shadow));
    expect(readFileSync(join(root, test), "utf8")).toBe(files[test]);
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    expect(change.files.map((f) => ({ path: f.path, status: f.status }))).toEqual([{ path: shadow, status: "deleted" }]);
    const after = await buildGraph({ repoRoot: root, store: null });
    expect(after.frameworks?.roles.filter((r) => r.plugin === "junit")).toHaveLength(1);
    expect(after.frameworks?.edges.filter((e) => e.plugin === "junit" && e.kind === "tests")).toHaveLength(1);
    console.log("JUnit metadata: 1 deleted annotation file, unchanged test source, roles 0 to 1.");
  });
});
