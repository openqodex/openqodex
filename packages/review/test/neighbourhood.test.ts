// Ways it could fail, written before the code:
// 1. A language without a graph loses the other side of a changed method.
// 2. Removed or replaced identifiers disappear with their old lines.
// 3. Declaration patterns select symbols instead of rarity selecting them.
// 4. Common names crowd out rare names, or ties exceed the per-file cap.
// 5. Earlier uses fill the site cap before declarations can be collected.
// 6. Changed lines are shown as sites, or context has wrong line numbers.
// 7. The time cap throws or silently presents an unfinished scan as complete.
// 8. Graph callers lose priority, certainty, alias sites or their target.
// 9. Packet writes overwrite repository files or follow a link outside.
// 10. A found secret reaches either the packet or the inline block.
// 11. A byte cap splits a symbol, exceeds its budget or loses the packet path.
// 12. File filtering counts generated, binary or oversized files.
// 13. A missing snapshot throws instead of returning a partial packet.
// 14. A repository scan exceeds its time cap without saying it is partial.
// 15. A body edit or removed symbol loses callers absent from changed text.
// 16. A long context or oversized symbol prevents later symbols being shown.
// 17. Names without sites consume every per-file slot.
// 18. A statement call is mistaken for a declaration.
// 19. The name-frequency cap removes certain graph evidence.
// 20. An ignored site directory also hides its changed-file candidates.
// 21. Repeated rendering makes the byte budget quadratic in symbol count.
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Change, ImpactSummary } from "@openqodex/core";
import { afterAll, expect, it, vi } from "vitest";
import { makeChange } from "../../core/src/test-fixtures.js";
import {
  buildNeighbourhood, renderNeighbourhoodBlock, NEIGHBOURHOOD_BLOCK_BYTES,
  NEIGHBOURHOOD_MAX_BYTES, NEIGHBOURHOOD_SITES_PER_SYMBOL,
  NEIGHBOURHOOD_SYMBOLS_PER_FILE, NEIGHBOURHOOD_TIME_MS,
} from "../src/neighbourhood.js";
import type { Neighbourhood } from "../src/neighbourhood.js";
import { snapshotFiles } from "../src/snapshot.js";

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

function snapshot(files: Record<string, string | Buffer> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "oq-neighbourhood-"));
  folders.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function change(dir: string, lines: Record<string, number[]>, diffs: Change["diffs"] = []): Change {
  const paths = [...new Set([...Object.keys(lines), ...diffs!.map((d) => d.path)])];
  return makeChange({
    repoRoot: dir,
    files: paths.map((path) => ({ path, status: "modified", oldPath: null, binary: false })),
    changedPaths: Object.keys(lines),
    coverage: new Map(Object.entries(lines).map(([path, numbers]) => [path, new Set(numbers)])),
    deletionPoints: new Map(),
    diffs,
    diff: diffs!.map((d) => d.text).join("\n"),
  });
}

function build(dir: string, input: Change, over: Partial<Parameters<typeof buildNeighbourhood>[0]> = {}): Neighbourhood {
  return buildNeighbourhood({ snapshotDir: dir, change: input, impact: null, secrets: [], ...over });
}

function impact(callers: ImpactSummary["callers"] = []): ImpactSummary {
  return {
    version: 2, status: "ok", reasons: [], risk: "low",
    build: { durationMs: 0, cacheHits: 0, parses: 2, eligibleFiles: 2, parsedFiles: 2, omittedFiles: 0, unresolvedSites: 0, externalSites: 0, mode: "fresh", generation: null },
    symbols: [{ id: "seed", file: "changed.ts", name: "reprice", kind: "function", startLine: 1, endLine: 1, snapshot: "current" }],
    touched: ["seed"], removed: [], callers, callees: [], importers: [], hubs: [], exports: [],
    unknown: { floor: false, seeds: [], causes: {}, near: [], nearTotal: 0, notRead: [], notReadTotal: 0 },
    cuts: [], truncated: { walk: false, inline: false, omittedSites: 0 }, packet: null,
  };
}

function certainCaller(file: string): ImpactSummary {
  return impact([{ seed: "seed", edges: [{ from: "caller", to: "seed", kind: "calls", sites: [
    { file, line: 1, column: 8, tier: "certain", evidence: "import", via: null, note: null, rule: "import" },
  ] }] }]);
}

it("lists the Java caller without needing a graph", () => {
  const dir = snapshot({
    "A.java": "class A {\n  public int reprice(int amount) {\n    return amount;\n  }\n}\n",
    "B.java": "class B {\n  int total(A instance) {\n    return instance.reprice(10);\n  }\n}\n",
  });
  const packet = build(dir, change(dir, { "A.java": [2] }));
  expect(packet.partial).toBeNull();
  expect(packet.symbols.find((s) => s.name === "reprice")).toMatchObject({
    files: 2, changedIn: ["A.java"], sites: [{ path: "B.java", line: 3, kind: "used", from: "text" }],
  });
  expect(readFileSync(join(dir, packet.packetPath!), "utf8")).toContain("used at B.java:3 (by name, unverified: the same name may be another thing)");
});

it("finds a removed C function's remaining use from only the old diff lines", () => {
  const dir = snapshot({ "B.c": "int total(void) {\n  return removedPrice();\n}\n" });
  const packet = build(dir, change(dir, {}, [{ path: "A.c", text: "--- a/A.c\n+++ /dev/null\n@@ -1 +0,0 @@\n-int removedPrice(void) { return 10; }\n" }]));
  expect(packet.symbols.find((s) => s.name === "removedPrice")).toMatchObject({ files: 1, changedIn: ["A.c"], sites: [{ path: "B.c", line: 2, from: "text" }] });
  expect(packet.symbols.some((s) => s.name === "dev")).toBe(false);
});

it("keeps a replaced identifier from the removed side of a modification", () => {
  const dir = snapshot({ "A.c": "int currentPrice(void);\n", "B.c": "return previousPrice();\n" });
  const packet = build(dir, change(dir, { "A.c": [1] }, [{ path: "A.c", text: "@@ -1 +1 @@\n-int previousPrice(void);\n+int currentPrice(void);\n" }]));
  expect(packet.symbols.find((s) => s.name === "previousPrice")?.sites[0]?.path).toBe("B.c");
});

it("selects Kotlin and shell identifiers even where no declaration pattern labels them", () => {
  const dir = snapshot({
    "changed.kt": "fun Cart.kotlinPrice() = 10\n",
    "use.kt": "val total = cart.kotlinPrice()\n",
    "changed.sh": ":; shell_price() { printf 10; }\n",
    "use.sh": "total=$(shell_price)\n",
  });
  const packet = build(dir, change(dir, { "changed.kt": [1], "changed.sh": [1] }));
  expect(packet.symbols.find((s) => s.name === "kotlinPrice")?.sites).toContainEqual(expect.objectContaining({ path: "use.kt", kind: "used" }));
  expect(packet.symbols.find((s) => s.name === "shell_price")?.sites).toContainEqual(expect.objectContaining({ path: "use.sh", kind: "used" }));
});

it("skips identifiers present in more files than the configured file cap", () => {
  const dir = snapshot({ "changed.txt": "commonName rareName\n", "one.txt": "commonName rareName\n", "two.txt": "commonName\n" });
  const packet = build(dir, change(dir, { "changed.txt": [1] }), { maxFilesPerSymbol: 2 });
  expect(packet.symbols.map((s) => s.name)).toEqual(["rareName"]);
});

it("ranks by file count then name and limits each changed file's selections", () => {
  const names = Array.from({ length: NEIGHBOURHOOD_SYMBOLS_PER_FILE + 2 }, (_, i) => `symbol${String(i).padStart(2, "0")}`);
  const dir = snapshot({ "changed.txt": `${names.toReversed().join(" ")} frequentName\n`, "other.txt": `${names.join(" ")} frequentName\n`, "third.txt": "frequentName\n" });
  const packet = build(dir, change(dir, { "changed.txt": [1] }));
  expect(packet.symbols.map((s) => s.name)).toEqual(names.slice(0, NEIGHBOURHOOD_SYMBOLS_PER_FILE));
});

it("matches whole case-sensitive identifiers and ignores short names and common keywords", () => {
  const dir = snapshot({ "changed.txt": "return int string self None actualName abc abc2 12abc _id\nabc _id\n", "other.txt": "actualNames ActualName abc2 actualName\n" });
  const packet = build(dir, change(dir, { "changed.txt": [1] }));
  expect(packet.symbols.map((s) => s.name).sort()).toEqual(["_id", "abc", "abc2", "actualName"]);
  expect(packet.symbols.find((s) => s.name === "abc")?.files).toBe(1);
  expect(packet.symbols.find((s) => s.name === "actualName")?.files).toBe(2);
});

it("reserves declaration sites even when earlier uses already fill the site cap", () => {
  const files: Record<string, string> = { "changed.txt": "reprice\n", "z-definition.py": "def reprice():\n  pass\n" };
  for (let i = 0; i < NEIGHBOURHOOD_SITES_PER_SYMBOL + 2; i++) files[`a-use-${i}.py`] = "result = reprice()\n";
  const dir = snapshot(files);
  const sites = build(dir, change(dir, { "changed.txt": [1] })).symbols[0].sites;
  expect(sites).toHaveLength(NEIGHBOURHOOD_SITES_PER_SYMBOL);
  expect(sites[0]).toMatchObject({ path: "z-definition.py", kind: "declared" });
});

it("excludes only added lines as sites and preserves the snapshot's context numbers", () => {
  const dir = snapshot({ "changed.txt": "before\nreprice\nchanged reprice\nafter\nreprice\nend\n" });
  const input = change(dir, { "changed.txt": [3] });
  input.deletionPoints.set("changed.txt", [{ after: 1, lines: 1, anchors: [1, 2] }]);
  const sites = build(dir, input).symbols.find((s) => s.name === "reprice")!.sites;
  expect(sites.map((s) => s.line)).toEqual([2, 5]);
  expect(sites[1].context).toBe("3\tchanged reprice\n4\tafter\n5\treprice\n6\tend");
});

it("returns a partial packet when now steps beyond the time cap during the file scan", () => {
  const dir = snapshot({ "a.txt": "reprice\n", "b.txt": "result = reprice()\n", "c.txt": "result = reprice()\n" });
  let ticks = 0;
  const packet = build(dir, change(dir, { "a.txt": [1] }), { now: () => ticks++ < 8 ? 0 : NEIGHBOURHOOD_TIME_MS + 1 });
  expect(packet.partial).toMatch(/^Time cap reached after 2 of 3 files;/);
  expect(packet.durationMs).toBeGreaterThan(NEIGHBOURHOOD_TIME_MS);
  const symbol = packet.symbols.find((s) => s.name === "reprice")!;
  expect(symbol.files).toBeLessThan(3);
  expect(symbol.sites.map((s) => s.path)).toEqual(["b.txt"]);
});

it("keeps a shared name when 31 local names have no sites", () => {
  const local = Array.from({ length: 31 }, (_, i) => `local${i}`);
  const dir = snapshot({ "changed.txt": `${local.join(" ")} sharedName\n`, "use.txt": "return sharedName();\n" });
  const packet = build(dir, change(dir, { "changed.txt": [1] }));
  expect(packet.symbols.map((s) => s.name)).toEqual(["sharedName"]);
});

it("labels a statement call at the start of a line as used", () => {
  const dir = snapshot({ "changed.js": "function reprice() {}\n", "B.js": "  reprice(10); \n" });
  const packet = build(dir, change(dir, { "changed.js": [1] }));
  expect(packet.symbols[0].sites).toEqual([expect.objectContaining({ path: "B.js", kind: "used" })]);
});

it("keeps certain graph callers when only a function body changes", () => {
  const dir = snapshot({ "changed.ts": "export function reprice() {\n  return 20;\n}\n", "caller.ts": "return aliasPrice();\n" });
  const packet = build(dir, change(dir, { "changed.ts": [2] }), { impact: certainCaller("caller.ts") });
  expect(packet.symbols[0]).toMatchObject({ name: "reprice", changedIn: ["changed.ts"] });
  expect(packet.symbols[0].sites[0]).toMatchObject({ path: "caller.ts", from: "graph" });
});

it("seeds removed graph symbols when the diff has no removed text", () => {
  const dir = snapshot({ "caller.ts": "return aliasPrice();\n" });
  const graph = certainCaller("caller.ts");
  graph.symbols[0].snapshot = "base";
  graph.touched = [];
  graph.removed = ["seed"];
  const input = change(dir, {}, [{ path: "changed.ts", text: "" }]);
  input.files[0].status = "deleted";
  const packet = build(dir, input, { impact: graph });
  expect(packet.symbols[0]).toMatchObject({ name: "reprice", changedIn: ["changed.ts"], files: 0 });
  expect(packet.symbols[0].sites[0]).toMatchObject({ path: "caller.ts", from: "graph" });
});

it.each(["a-caller.ts", "z-caller.ts"])("keeps a certain graph caller in %s after the name exceeds the file cap", (caller) => {
  const dir = snapshot({ "changed.ts": "export function reprice() {}\n", "b-use.ts": "return reprice();\n", "c-use.ts": "return reprice();\n", [caller]: "return reprice();\n" });
  const packet = build(dir, change(dir, { "changed.ts": [1] }), { impact: certainCaller(caller), maxFilesPerSymbol: 2 });
  expect(packet.symbols[0]).toMatchObject({ name: "reprice", filesOverCap: 2 });
  expect(packet.symbols[0].sites).toEqual([expect.objectContaining({ path: caller, from: "graph" })]);
  expect(renderNeighbourhoodBlock(packet)).toContain("reprice: over 2 snapshot files");
  expect(readFileSync(join(dir, packet.packetPath!), "utf8")).toContain("reprice: over 2 snapshot files");
});

it("takes candidates from a changed file under src/build", () => {
  const dir = snapshot({ "src/build/compile.ts": "export function compileAsset() {}\n", "src/use.ts": "return compileAsset();\n" });
  const packet = build(dir, change(dir, { "src/build/compile.ts": [1] }));
  expect(packet.symbols[0]).toMatchObject({ name: "compileAsset", changedIn: ["src/build/compile.ts"], sites: [{ path: "src/use.ts" }] });
});

it("clips a 100 KB site without emptying the packet", () => {
  const dir = snapshot({ "changed.txt": "rareName sharedName\n", "minified.js": `return rareName(); ${"x".repeat(100 * 1024)}\n`, "use.txt": "return sharedName();\n" });
  const packet = build(dir, change(dir, { "changed.txt": [1] }));
  expect(packet.symbols.map((s) => s.name)).toEqual(["rareName", "sharedName"]);
  const context = packet.symbols[0].sites[0].context;
  expect(context.endsWith(" [cut]")).toBe(true);
  expect(context).toHaveLength("1\t".length + 240 + " [cut]".length);
  expect(renderNeighbourhoodBlock(packet)).toContain("sharedName");
  expect(Buffer.byteLength(readFileSync(join(dir, packet.packetPath!)))).toBeLessThanOrEqual(NEIGHBOURHOOD_MAX_BYTES);
});

it("puts certain graph callers first, including aliases, without promoting likely sites", () => {
  const dir = snapshot({
    "changed.ts": "export function reprice() {}\n",
    "a-definition.py": "def reprice(): pass\n",
    "b-likely.ts": "return reprice();\n",
    "z-caller.ts": "return aliasPrice();\n",
  });
  const graph = impact([{ seed: "seed", edges: [{ from: "caller", to: "seed", kind: "calls", sites: [
    { file: "z-caller.ts", line: 1, column: 8, tier: "certain", evidence: "import", via: null, note: null, rule: "import" },
    { file: "b-likely.ts", line: 1, column: 8, tier: "likely", evidence: "convention", via: null, note: null, rule: "convention" },
    { file: "changed.ts", line: 1, column: 1, tier: "certain", evidence: "same-scope", via: null, note: null, rule: "same-scope" },
  ] }] }]);
  const packet = build(dir, change(dir, { "changed.ts": [1] }), { impact: graph });
  const symbol = packet.symbols.find((s) => s.name === "reprice")!;
  expect(symbol.files).toBe(3);
  expect(symbol.sites[0]).toMatchObject({ path: "z-caller.ts", kind: "used", from: "graph" });
  expect(symbol.sites[1]).toMatchObject({ path: "a-definition.py", kind: "declared", from: "text" });
  expect(symbol.sites.find((s) => s.path === "b-likely.ts")?.from).toBe("text");
  expect(symbol.sites.some((s) => s.path === "changed.ts")).toBe(false);
  expect(renderNeighbourhoodBlock(packet)).toContain("used at z-caller.ts:1 (from the code graph)");
});

it("writes a private packet inside the snapshot", () => {
  const dir = snapshot({ "changed.txt": "reprice\nreprice\n" });
  const packet = build(dir, change(dir, { "changed.txt": [1] }));
  expect(packet.packetPath).toBe(".openqodex-review/neighbourhood.md");
  expect(isAbsolute(packet.packetPath!)).toBe(false);
  expect(relative(dir, join(dir, packet.packetPath!))).toBe(packet.packetPath);
  expect(lstatSync(join(dir, packet.packetPath!)).mode & 0o777).toBe(0o600);
});

it("refuses a repository packet collision without changing its content", () => {
  const path = ".openqodex-review/neighbourhood.md";
  const dir = snapshot({ "changed.txt": "reprice\nreprice\n", [path]: "repository content\n" });
  const packet = build(dir, change(dir, { "changed.txt": [1] }));
  expect(packet.packetPath).toBeNull();
  expect(packet.partial).toMatch(/collision|already exists/i);
  expect(readFileSync(join(dir, path), "utf8")).toBe("repository content\n");
});

it("shares only the graph packet's known directory without overwriting either packet", () => {
  const dir = snapshot({ "changed.txt": "reprice\nreprice\n", ".openqodex-review/graph/index.md": "graph packet\n" });
  const packet = build(dir, change(dir, { "changed.txt": [1] }), { impact: { ...impact(), packet: ".openqodex-review/graph/" } });
  expect(packet.partial).toBeNull();
  expect(packet.packetPath).toBe(".openqodex-review/neighbourhood.md");
  expect(readFileSync(join(dir, ".openqodex-review/graph/index.md"), "utf8")).toBe("graph packet\n");
});

it("refuses a second packet write even beside an existing graph packet", () => {
  const path = ".openqodex-review/neighbourhood.md";
  const dir = snapshot({ "changed.txt": "reprice\nreprice\n", [path]: "repository content\n", ".openqodex-review/graph/index.md": "graph packet\n" });
  const packet = build(dir, change(dir, { "changed.txt": [1] }), { impact: { ...impact(), packet: ".openqodex-review/graph/" } });
  expect(packet.packetPath).toBeNull();
  expect(packet.partial).toMatch(/collision|already exists/i);
  expect(readFileSync(join(dir, path), "utf8")).toBe("repository content\n");
});

it("refuses to follow the packet root outside the snapshot", () => {
  const outside = snapshot();
  const dir = snapshot({ "changed.txt": "reprice\nreprice\n" });
  symlinkSync(outside, join(dir, ".openqodex-review"));
  const packet = build(dir, change(dir, { "changed.txt": [1] }), { impact: { ...impact(), packet: ".openqodex-review/graph/" } });
  expect(packet.packetPath).toBeNull();
  expect(packet.partial).toMatch(/collision|link/i);
  expect(snapshotFiles(outside)).toEqual([]);
});

it("redacts secrets in symbols, paths and context before either output is rendered", () => {
  const secret = ["sensitive", "value"].join("_");
  const dir = snapshot({ "changed.txt": `reprice ${secret}\n`, [`${secret}.txt`]: `return reprice(); // ${secret}\n`, "clipped.txt": `reprice ${" ".repeat(222)}${secret} tail\n` });
  const packet = build(dir, change(dir, { "changed.txt": [1] }), { secrets: [secret] });
  expect(JSON.stringify(packet)).not.toContain(secret);
  expect(JSON.stringify(packet)).not.toContain(secret.slice(0, 10));
  expect(readFileSync(join(dir, packet.packetPath!), "utf8")).not.toContain(secret);
  expect(renderNeighbourhoodBlock(packet)).not.toContain(secret);
  expect(renderNeighbourhoodBlock(packet)).toContain("redacted");
});

it("cuts the packet on a whole symbol boundary and reports how many symbols were cut", () => {
  const names = Array.from({ length: NEIGHBOURHOOD_SYMBOLS_PER_FILE }, (_, i) => `symbol${i}`);
  const sites = Array.from({ length: NEIGHBOURHOOD_SITES_PER_SYMBOL }, () => `${names.join(" ")} ${"字".repeat(240)}\n`).join("");
  const dir = snapshot({ "changed.txt": `${names.join(" ")}\n`, "use.txt": sites });
  const packet = build(dir, change(dir, { "changed.txt": [1] }));
  const text = readFileSync(join(dir, packet.packetPath!), "utf8");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(NEIGHBOURHOOD_MAX_BYTES);
  expect(packet.symbols.length).toBeGreaterThan(0);
  expect(packet.symbols.length).toBeLessThan(names.length);
  expect(text.trimEnd()).toMatch(new RegExp(`${names.length - packet.symbols.length} symbols cut[^\\n]*$`));
  expect((text.match(/^```$/gm) ?? []).length).toBe(packet.symbols.reduce((count, symbol) => count + symbol.sites.length * 2, 0));
});

it("keeps repository backticks inside context fences", () => {
  const dir = snapshot({ "changed.txt": "reprice\n", "use.txt": "```\nreturn reprice();\n```\n" });
  const packet = build(dir, change(dir, { "changed.txt": [1] }));
  expect(renderNeighbourhoodBlock(packet)).toContain("````\n1\t```\n2\treturn reprice();\n3\t```\n````");
});

function largePacket(): Neighbourhood {
  return {
    symbols: Array.from({ length: 20 }, (_, i) => ({
      name: `symbol${i}`, changedIn: [i % 2 === 0 ? "A.java" : "B.c"], files: 2,
      sites: [{ path: "use.txt", line: 1, kind: "used" as const, from: "text" as const, context: `1\t${"字".repeat(1000)}` }],
    })),
    packetPath: ".openqodex-review/neighbourhood.md", partial: "Time cap reached after 20 of 30 files.", durationMs: 10_001,
  };
}

it("cuts the inline block by bytes and names the packet for the remaining symbols", () => {
  const packet = largePacket();
  const text = renderNeighbourhoodBlock(packet);
  expect(text.startsWith("## Code around the change\n")).toBe(true);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(NEIGHBOURHOOD_BLOCK_BYTES);
  expect(text).toContain(packet.packetPath);
  expect(text).toContain(packet.partial);
  const shown = (text.match(/^#### /gm) ?? []).length;
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(packet.symbols.length);
  expect((text.match(/^```$/gm) ?? []).length).toBe(shown * 2);
});

it("keeps later symbols when an earlier symbol exceeds the inline byte cap", () => {
  const packet = largePacket();
  packet.symbols = packet.symbols.slice(0, 2);
  packet.symbols[0].sites[0].context = `1\t${"x".repeat(NEIGHBOURHOOD_BLOCK_BYTES)}`;
  packet.symbols[1].sites[0].context = "1\treturn symbol1();";
  const text = renderNeighbourhoodBlock(packet);
  expect(text).not.toContain("symbol0");
  expect(text).toContain("symbol1");
  expect(text).toContain("remaining 1 symbols");
  expect(text).toContain(packet.packetPath);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(NEIGHBOURHOOD_BLOCK_BYTES);
});

it("renders only the changed files requested without reordering their symbols", () => {
  const packet = largePacket();
  packet.symbols = packet.symbols.slice(0, 4).map((s) => ({ ...s, sites: [] }));
  packet.symbols[0].changedIn.push("B.c");
  const text = renderNeighbourhoodBlock(packet, ["B.c"]);
  expect(text).not.toContain("A.java");
  expect(text).toContain("symbol0");
  expect(text.indexOf("symbol0")).toBeLessThan(text.indexOf("symbol1"));
  expect(text.indexOf("symbol1")).toBeLessThan(text.indexOf("symbol3"));
  expect(text).not.toContain("symbol2");
});

it("returns no inline block for an empty packet or a filter with no symbols", () => {
  expect(renderNeighbourhoodBlock({ symbols: [], packetPath: null, partial: "Time cap reached after 0 of 3 files.", durationMs: 10_001 })).toBe("");
  expect(renderNeighbourhoodBlock(largePacket(), ["absent.txt"])).toBe("");
});

it("does not count ignored directories, binary files, non-UTF8 files or files over 512 KB", () => {
  const files: Record<string, string | Buffer> = { "changed.txt": "reprice\n", "use.txt": "return reprice();\n", "binary": Buffer.from("reprice\0"), "invalid": Buffer.from([114, 101, 112, 114, 105, 99, 101, 0xff]), "large.txt": `reprice ${" ".repeat(512 * 1024)}` };
  for (const name of [".git", "node_modules", "vendor", "dist", "build", "target", ".openqodex", ".openqodex-review"]) files[`nested/${name}/use.txt`] = "reprice\n";
  const dir = snapshot(files);
  const packet = build(dir, change(dir, { "changed.txt": [1] }));
  expect(packet.symbols[0]).toMatchObject({ name: "reprice", files: 2, sites: [{ path: "use.txt" }] });
});

it("prunes an ignored directory before listing its many files", () => {
  const dir = snapshot({ "changed.txt": "reprice\n", "use.txt": "reprice\n" });
  const ignored = join(dir, "node_modules");
  mkdirSync(ignored);
  for (let i = 0; i < 2000; i++) writeFileSync(join(ignored, `use-${i}.txt`), "reprice\n");
  const reads = vi.spyOn(fs, "readdirSync");
  syncBuiltinESMExports();
  try {
    const packet = build(dir, change(dir, { "changed.txt": [1] }));
    expect(packet.partial).toBeNull();
    expect(reads.mock.calls.map(([path]) => String(path))).not.toContain(ignored);
    expect(packet.symbols[0]!.files).toBe(2);
  } finally { reads.mockRestore(); syncBuiltinESMExports(); }
});

it("stops listing directories at the time cap and marks the walked portion partial", () => {
  const dir = snapshot({ "a/changed.txt": "reprice\n", "b/use.txt": "reprice\n", "c/use.txt": "reprice\n" });
  let ticks = 0;
  const reads = vi.spyOn(fs, "readdirSync");
  syncBuiltinESMExports();
  try {
    const packet = build(dir, change(dir, { "a/changed.txt": [1] }), { now: () => ticks++ < 3 ? 0 : NEIGHBOURHOOD_TIME_MS + 1 });
    expect(packet.partial).toMatch(/^Time cap reached/);
    expect(reads.mock.calls.map(([path]) => String(path))).not.toContain(join(dir, "b"));
    expect(reads.mock.calls.map(([path]) => String(path))).toContain(join(dir, "a"));
  } finally { reads.mockRestore(); syncBuiltinESMExports(); }
});

it("returns a partial packet instead of throwing when the snapshot cannot be listed", () => {
  const dir = snapshot();
  const packet = build(join(dir, "missing"), change(dir, { "changed.txt": [1] }));
  expect(packet.packetPath).toBeNull();
  expect(packet.symbols).toEqual([]);
  expect(packet.partial).toMatch(/ENOENT/);
});

it("finishes a 10,000-file snapshot within the time cap", () => {
  const dir = snapshot({ "changed.txt": "rarePrice\n" });
  for (let i = 0; i < 9999; i++) writeFileSync(join(dir, `use-${i}.txt`), "return rarePrice();\n");
  const packet = build(dir, change(dir, { "changed.txt": [1] }));
  process.stdout.write(`Neighbourhood on 10,000 files: ${packet.durationMs.toFixed(1)} ms, partial: ${packet.partial ?? "no"}\n`);
  expect(packet.durationMs).toBeLessThan(NEIGHBOURHOOD_TIME_MS);
  expect(packet.partial).toBeNull();
}, 120_000);

it("measures the repository's own tree as a snapshot and marks any time cap", () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const dir = snapshot();
  const ignored = new Set([".git", "node_modules", "dist", "build", "target", ".pnpm-store", ".openqodex", ".openqodex-review", ".private", ".claude", ".agents", ".codex", ".aws", "credentials"]);
  // Saved benchmark runs are ignored data, not the tree; a laptop may hold hundreds of megabytes of them.
  const isRunData = (rel: string) => rel === "benchmark/results" || rel.startsWith("benchmark/results/");
  cpSync(repo, dir, { recursive: true, filter: (path) => { const rel = relative(repo, path); return !isRunData(rel.split("\\").join("/")) && !rel.split(/[\\/]/).some((part) => ignored.has(part) || part.startsWith(".env") || part === "settings.local.json"); } });
  const path = "packages/review/src/neighbourhood.ts";
  const line = readFileSync(join(dir, path), "utf8").split("\n").findIndex((row) => row.startsWith("export function buildNeighbourhood")) + 1;
  expect(line).toBeGreaterThan(0);
  const packet = build(dir, change(dir, { [path]: [line] }));
  process.stdout.write(`Neighbourhood on repository tree: ${packet.durationMs.toFixed(1)} ms, ${snapshotFiles(dir).length} files, ${packet.symbols.length} symbols, partial: ${packet.partial ?? "no"}\n`);
  expect(packet.symbols.length).toBeGreaterThan(0);
  expect(packet.durationMs < NEIGHBOURHOOD_TIME_MS || packet.partial !== null).toBe(true);
}, 120_000);
