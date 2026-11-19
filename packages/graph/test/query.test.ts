// The one query function behind the graph commands. Ways it could fail,
// each checked on a real repo:
// 1. An ambiguous name picks one definition silently, so an agent reads the
//    callers of the wrong function.
// 2. Zero callers on a floor reads as "unused": the answer must say
//    floor true with the reasons, and a count the graph cannot know is
//    null, never zero.
// 3. The command line and the review packet disagree about the callers of
//    one symbol in one graph (adapter parity).
// 4. A cursor from another request or another build pages through the wrong
//    list instead of being refused.
// 5. `explain` of an edge that is not in the graph returns an empty success.
// 6. Search results are counted as callers, or a hit with only part of the
//    name is put with the exact matches.
// 7. An operation that did not run says nothing about which graph answered.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact, symbolKey } from "../src/index.js";
import { edgeId, query } from "../src/query/engine.js";
import type { Item, Session } from "../src/query/engine.js";
import { PACKET_DIR, writePacket } from "../src/review/packet.js";
import { commitAll, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

async function session(files: Record<string, string>): Promise<{ root: string; s: Session }> {
  const root = makeRepo(files);
  const graph = await buildGraph({ repoRoot: root, store: null });
  return { root, s: { graph, generation: "test-build", treeSha: null, builtAt: null, laterEditsKnown: false } };
}

const twoRun = {
  "a.ts": "export function run() {\n  return 1;\n}\n",
  "b.ts": "export function run() {\n  return 2;\n}\n",
  "c.ts": 'import { run } from "./a";\nexport function go() {\n  return run();\n}\n',
};

describe("the graph query", () => {
  it("returns the candidates of an ambiguous name and no items (1)", async () => {
    const { s } = await session(twoRun);
    const a = query(s, { apiVersion: 1, kind: "callers", target: { name: "run" } });
    expect(a.error?.code).toBe("ambiguous");
    expect(Array.isArray(a.target) && a.target.map((c) => c.file).sort()).toEqual(["a.ts", "b.ts"]);
    expect(a.items).toEqual([]);
    const one = query(s, { apiVersion: 1, kind: "callers", target: { name: "run", file: "a.ts" } });
    expect((one.items as Item[]).map((i) => `${i.site.file}:${i.site.line}`)).toEqual(["c.ts:3"]);
  });

  it("marks zero callers on a floor as a floor with its reasons (2)", async () => {
    const { s } = await session({
      "lib.ts": "export function target() {\n  return 1;\n}\n",
      "use.ts": "export function run(handlers: Record<string, () => void>, key: string) {\n  handlers[key]();\n}\n",
    });
    const a = query(s, { apiVersion: 1, kind: "callers", target: { name: "target" } });
    expect(a.items).toEqual([]);
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.reasons.join(" ")).toMatch(/through a value/);
    expect(a.counts).toEqual({ certain: 0, likely: 0, possible: 0 });
    // A status the build did not count stays null.
    expect(query(s, { apiVersion: 1, kind: "status" }).counts.certain).toBeNull();
  });

  it("gives the same callers the review packet holds for the same graph (3)", async () => {
    const files: Record<string, string> = { "src/core.ts": "export function core(): number {\n  return 1;\n}\n" };
    for (let i = 0; i < 25; i++) files[`src/c${i}.ts`] = `import { core } from "./core.js";\nexport function c${i}() {\n  return core();\n}\n`;
    const root = makeRepo(files);
    commitAll(root);
    writeFiles(root, { "src/core.ts": "export function core(): number {\n  return 2;\n}\n" });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const graph = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(graph, change);
    await writePacket({ root, repoRoot: root, graph, impact, baseSha: change.baseSha, secrets: [] });
    const seed = impact.touched[0] as string;
    const packet = JSON.parse(readFileSync(join(root, PACKET_DIR, "callers", `${symbolKey(seed)}.json`), "utf8")) as { items: { site: { file: string; line: number } }[] };
    const s: Session = { graph, generation: null, treeSha: null, builtAt: null, laterEditsKnown: false };
    const cli = query(s, { apiVersion: 1, kind: "callers", target: { id: seed }, limit: 500 });
    const key = (x: { site: { file: string; line: number } }) => `${x.site.file}:${x.site.line}`;
    expect((cli.items as Item[]).map(key).sort()).toEqual(packet.items.map(key).sort());
  });

  it("refuses a cursor from another request (4)", async () => {
    const files: Record<string, string> = { "core.ts": "export function core() {\n  return 1;\n}\n" };
    for (let i = 0; i < 5; i++) files[`c${i}.ts`] = `import { core } from "./core";\nexport function c${i}() {\n  return core();\n}\n`;
    const { s } = await session(files);
    const first = query(s, { apiVersion: 1, kind: "callers", target: { name: "core" }, limit: 2 });
    expect(first.truncated).toMatchObject({ by: "limit", omitted: 3, omittedExact: true });
    const next = query(s, { apiVersion: 1, kind: "callers", target: { name: "core" }, limit: 2, cursor: first.truncated.cursor as string });
    expect(next.items).toHaveLength(2);
    const other = query(s, { apiVersion: 1, kind: "callees", target: { name: "core" }, cursor: first.truncated.cursor as string });
    expect(other.error?.code).toBe("generation-unavailable");
  });

  it("explains an edge from its id and refuses one that is not there (5)", async () => {
    const { s } = await session(twoRun);
    const a = query(s, { apiVersion: 1, kind: "callers", target: { name: "run", file: "a.ts" } });
    const edge = (a.items[0] as Item).edge;
    const why = query(s, { apiVersion: 1, kind: "explain", target: { id: edge } });
    expect(why.error).toBeNull();
    expect(why.items[0]).toMatchObject({ edge, site: { tier: "certain", evidence: "import" } });
    const item = a.items[0] as Item;
    const elsewhere = edgeId({ kind: item.kind, from: item.from, to: item.to }, { ...item.site, line: 9 });
    expect(query(s, { apiVersion: 1, kind: "explain", target: { id: elsewhere } }).error?.code).toBe("not-found");
  });

  it("returns exact search hits as items and the rest as leads, never counted (6)", async () => {
    const { s } = await session(twoRun);
    const a = query(s, { apiVersion: 1, kind: "search", text: "run" });
    expect((a.items as { file: string }[]).map((l) => l.file).sort()).toEqual(["a.ts", "b.ts"]);
    expect(a.leads).toEqual([]);
    expect(a.counts).toEqual({ certain: null, likely: null, possible: null });
    const part = query(s, { apiVersion: 1, kind: "search", text: "un" });
    expect(part.items).toEqual([]);
    expect(part.leads.map((l) => l.file).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("names the graph that answered on every answer, errors included (7)", async () => {
    const { s } = await session(twoRun);
    for (const kind of ["status", "capabilities", "callers", "explain"] as const) {
      const a = query(s, { apiVersion: 1, kind, target: { name: "nothing-here" } });
      expect(a.graph).toMatchObject({ generation: "test-build", status: "ok", mode: "fresh", freshness: { laterEditsKnown: false } });
    }
  });
});
