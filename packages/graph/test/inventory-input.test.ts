// A build over a folder git does not know: the server review's materialised
// snapshot, whose file list and content ids come from the caller, and whose
// base versions come through the caller's one scope-checking reader.
//
// Ways it could fail, written before the code:
//  1. A build from an inventory still runs git (it fails in a folder that
//     is not a git work tree), or the same files give another graph than
//     git's listing gives: other nodes, edges, removed symbols or export
//     changes. The git-backed default is the reference and does not change.
//  2. A base version, in the build or in the packet, is read from git in
//     the build folder rather than through the caller's reader, so a read
//     escapes the scope check.
//  3. A build from an inventory accepts a store or a capture, so a server
//     build would write graph state or a trust record.
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getChange } from "@openqodex/core";
import type { Change } from "@openqodex/core";
import { buildGraph, detectImpact } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { blobId } from "../src/capture/inventory.js";
import { showBlob } from "../src/capture/git.js";
import { writePacket } from "../src/review/packet.js";
import { commitAll, makeHome, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const BEFORE: Record<string, string> = {
  "package.json": '{ "name": "app", "version": "1.0.0" }\n',
  "src/core.ts": "export function core(): number {\n  return 1;\n}\nexport function gone(): number {\n  return 2;\n}\n",
  "src/use.ts": 'import { core, gone } from "./core";\nexport function use(): number {\n  return core() + gone();\n}\n',
  "src/old.ts": "export function old(): number {\n  return 3;\n}\n",
  "py/m.py": "def f():\n    return 1\n",
};
const AFTER: Record<string, string> = {
  "src/core.ts": "export function core(): number {\n  return 10;\n}\n",
  "src/use.ts": 'import { core } from "./core";\nexport function use(): number {\n  return core();\n}\n',
  "src/new.ts": 'import { use } from "./use";\nexport function fresh(): number {\n  return use();\n}\n',
};

type Built = { repo: string; copy: string; change: Change; reads: string[]; inventory: { path: string; blob: string }[] };

// The change in a git repository, and a copy of its files with no .git: the
// folder the inventory build reads. Every base read is recorded.
async function setup(): Promise<Built> {
  const repo = makeRepo(BEFORE);
  const base = commitAll(repo);
  writeFiles(repo, AFTER);
  rmSync(join(repo, "src/old.ts"));
  // Committed, so git's listing of the work tree is the head's files.
  commitAll(repo);
  const change = await getChange({ repoRoot: repo, scope: { base }, exclude: [] });
  const copy = join(tempDir("oq-graph-inv-"), "tree");
  cpSync(repo, copy, { recursive: true, filter: (src) => !src.split("/").includes(".git") });
  const files = ["package.json", "src/core.ts", "src/use.ts", "src/new.ts", "py/m.py"];
  const inventory = files.map((path) => ({ path, blob: blobId(readFileSync(join(copy, path))) }));
  return { repo, copy, change, reads: [], inventory };
}

const reader = (b: Built) => (path: string, maxBytes: number) => {
  b.reads.push(path);
  return showBlob(b.repo, b.change.baseSha, path, maxBytes);
};

// What the review reads of a graph, without the folder, the clock or the store.
function shape(g: Graph): unknown {
  return {
    nodes: [...g.nodes.keys()].sort(),
    edges: g.edges.map((e) => `${e.from} ${e.kind} ${e.to} ${e.tier} ${e.sites.map((s) => `${s.file}:${s.line}`).join(",")}`).sort(),
    removed: [...g.removed].map(([p, ns]) => `${p}: ${ns.map((n) => `${n.id}${n.movedTo ? ` -> ${n.movedTo.id}` : ""}`).join(",")}`).sort(),
    exports: g.exportChanges,
    status: { status: g.status.status, reasons: g.status.reasons, filesParsed: g.status.filesParsed, notRead: g.status.notRead, eligibleFiles: g.status.eligibleFiles },
  };
}

describe("a build from an inventory", () => {
  it("1. runs without git and gives the graph git's listing gives for the same files", async () => {
    const b = await setup();
    expect(existsSync(join(b.copy, ".git"))).toBe(false);
    const fromGit = await buildGraph({ repoRoot: b.repo, store: null, files: b.change.changedPaths, base: { sha: b.change.baseSha, files: b.change.files } });
    const fromList = await buildGraph({ repoRoot: b.copy, store: null, inventory: b.inventory, files: b.change.changedPaths, base: { sha: b.change.baseSha, files: b.change.files, read: reader(b) } });
    expect(shape(fromList)).toEqual(shape(fromGit));
    expect(fromList.removed.size).toBeGreaterThan(0);
    expect(fromList.repoRoot).toBe(b.copy);
  });

  it("2. reads every base version, in the build and in the packet, through the reader", async () => {
    const b = await setup();
    const graph = await buildGraph({ repoRoot: b.copy, store: null, inventory: b.inventory, files: b.change.changedPaths, base: { sha: b.change.baseSha, files: b.change.files, read: reader(b) } });
    expect([...new Set(b.reads)].sort()).toEqual(["src/core.ts", "src/old.ts", "src/use.ts"]);
    expect(graph.status.reasons.some((r) => r.includes("removed symbols were not checked"))).toBe(false);
    expect([...graph.removed.keys()].sort()).toEqual(["src/core.ts", "src/old.ts"]);
    const impact = detectImpact(graph, b.change);
    b.reads.length = 0;
    // repoRoot is the copy: git there would find no repository.
    const packet = await writePacket({ root: b.copy, repoRoot: b.copy, graph, impact, baseSha: b.change.baseSha, secrets: [], readBase: reader(b) });
    expect(b.reads.length).toBeGreaterThan(0);
    expect(packet.files.some((f) => f.startsWith("base/"))).toBe(true);
  });

  it("3. refuses a store or a capture", async () => {
    const b = await setup();
    const { openStore } = await import("../src/store/store.js");
    const opened = await openStore(b.repo, { home: makeHome() });
    if (!opened.ok) throw new Error(opened.reason);
    await expect(buildGraph({ repoRoot: b.copy, store: opened.store, inventory: b.inventory })).rejects.toThrow(/keeps nothing/);
    await expect(buildGraph({ repoRoot: b.copy, store: null, capture: "snapshot", inventory: b.inventory })).rejects.toThrow(/keeps nothing/);
  });
});
