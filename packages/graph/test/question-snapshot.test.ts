// The kept index as a ready-to-load snapshot for questions: a question on a
// work tree the graph folder already holds a complete build of, with its
// index, loads that index instead of resolving the graph again from facts.
// Ways it could fail, each on a real repo with the real store:
// 1. A second question on an unchanged work tree resolves the whole graph
//    again from its facts (what made every `openqodex graph` question slow
//    under the five-second line), because the build it reuses kept no
//    index or the index is not looked for.
// 2. An answer read from the kept index differs from the answer a fresh
//    build gives: an item, a count, a floor, the target or the graph block
//    (the build it names, its mode) is not byte for byte the same.
// 3. A kept index cut short, with a byte changed, or with a file of it
//    gone, is loaded anyway: a wrong answer, or a crash, instead of a
//    normal build from facts.
// 4. An edit to the work tree still loads the index of the old capture, so
//    a new caller is missing.
// 5. A question that compares the work tree with its base, or one forced
//    fresh (`graph build --full`), loads the index instead of building.
import { afterAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, parseTarget, pinWorkTree, query } from "../src/index.js";
import type { Pinned, Request } from "../src/index.js";
import { commitAll, makeHome, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const home = makeHome();
const settings = { budgetMs: 30_000, maxFiles: 4000, maxFileBytes: 512 * 1024, maxHeapMb: 1536 };

const files = {
  "package.json": '{ "name": "app", "private": true }\n',
  "src/store.ts": "export interface Store {\n  save(x: number): void;\n}\nexport class MemoryStore implements Store {\n  save(x: number): void {\n    log(x);\n  }\n}\nexport function log(x: number): void {\n  console.log(x);\n}\n",
  "src/service.ts": 'import { log, MemoryStore } from "./store";\nimport type { Store } from "./store";\nexport class Service {\n  constructor(private readonly store: Store) {}\n  run(): void {\n    this.store.save(1);\n    log(2);\n  }\n}\nexport function make(): Service {\n  return new Service(new MemoryStore());\n}\nexport function dyn(f: () => void): void {\n  f();\n}\n',
  "src/main.ts": 'import { make } from "./service";\nexport function main(): void {\n  make().run();\n}\n',
  "test/service.test.ts": 'import { make } from "../src/service";\nexport function checks(): void {\n  make().run();\n}\n',
  "py/m.py": "def f():\n    return g()\n\ndef g():\n    return 1\n",
};

// The questions an agent asks, each as the command line asks it.
const QUESTIONS: Omit<Request, "apiVersion">[] = [
  { kind: "callers", target: parseTarget("log") },
  { kind: "callers", target: parseTarget("MemoryStore.save"), depth: 3 },
  { kind: "callees", target: parseTarget("Service.run") },
  { kind: "symbol", target: parseTarget("make") },
  { kind: "references", target: parseTarget("Store") },
  { kind: "implementers", target: parseTarget("Store") },
  { kind: "search", text: "save" },
  { kind: "outline", target: { file: "src" } },
  { kind: "path", target: parseTarget("main"), to: parseTarget("log") },
  { kind: "importers", target: { file: "src/store.ts" } },
  { kind: "tests", target: parseTarget("make") },
  { kind: "impact", target: parseTarget("log") },
  { kind: "unknowns", target: { file: "src/service.ts" } },
  { kind: "cycles" },
  { kind: "packages" },
  { kind: "callers", target: parseTarget("g") },
  { kind: "callers", target: parseTarget("nothing") },
];

async function storeOf(root: string) {
  const opened = await openStore(root, { home });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.store;
}

async function ask(root: string, opts: { full?: boolean } = {}): Promise<{ answers: string[]; parses: number; cacheHits: number; generation: string | null; pinned: Pinned }> {
  const pinned = await pinWorkTree({ repoRoot: root, store: await storeOf(root), settings, purpose: "cli", full: opts.full });
  try {
    const s = pinned.session;
    const answers = QUESTIONS.map((q) => JSON.stringify(query(s, { apiVersion: 1, ...q })));
    return { answers, parses: s.graph.status.parses, cacheHits: s.graph.status.cacheHits, generation: s.generation, pinned };
  } finally {
    pinned.release();
  }
}

function repo(): string {
  const root = makeRepo(files);
  commitAll(root);
  return root;
}

const indexDir = (root: string, id: string) => join(root, ".openqodex", "graph", "generations", id, "index");

describe("a question on a work tree the graph folder already holds", () => {
  it("loads the kept index: nothing is parsed and no facts are read (1)", async () => {
    const root = repo();
    const first = await ask(root);
    expect(first.parses).toBeGreaterThan(0);
    const second = await ask(root);
    expect({ parses: second.parses, cacheHits: second.cacheHits }).toEqual({ parses: 0, cacheHits: 0 });
    expect(second.generation).toBe(first.generation);
    const third = await ask(root);
    expect({ parses: third.parses, cacheHits: third.cacheHits }).toEqual({ parses: 0, cacheHits: 0 });
  });

  it("answers byte for byte as a fresh build of the same tree does, for every question (2)", async () => {
    const root = repo();
    await ask(root);
    const loaded = await ask(root);
    expect(loaded.cacheHits + loaded.parses).toBe(0);
    const fresh = await ask(root, { full: true });
    // The fresh build resolved the graph from facts, so the comparison is between the two ways.
    expect(fresh.cacheHits).toBeGreaterThan(0);
    expect(fresh.generation).toBe(loaded.generation);
    expect(loaded.answers.length).toBe(QUESTIONS.length);
    for (const [i, a] of loaded.answers.entries()) expect(a, JSON.stringify(QUESTIONS[i])).toBe(fresh.answers[i]);
    // The questions found something: an empty graph would compare equal too.
    expect(JSON.parse(loaded.answers[0] as string).items.length).toBeGreaterThan(0);
  });

  const damages: [string, (dir: string) => void][] = [
    ["cut short", (dir) => {
      const text = readFileSync(join(dir, "edges.jsonl"), "utf8");
      writeFileSync(join(dir, "edges.jsonl"), text.slice(0, Math.floor(text.length / 2)));
    }],
    ["one byte changed, same length", (dir) => {
      const text = readFileSync(join(dir, "edges.jsonl"), "utf8");
      const i = text.search(/[1-8]/);
      writeFileSync(join(dir, "edges.jsonl"), `${text.slice(0, i)}${Number(text[i]) + 1}${text.slice(i + 1)}`);
    }],
    ["a file of it gone", (dir) => rmSync(join(dir, "strings.json"))],
    ["emptied", (dir) => {
      for (const f of readdirSync(dir)) writeFileSync(join(dir, f), "");
    }],
  ];
  for (const [name, damage] of damages) {
    it(`builds from facts instead when the kept index is ${name}, with the same answers (3)`, async () => {
      const root = repo();
      const first = await ask(root);
      const loaded = await ask(root);
      expect(loaded.cacheHits + loaded.parses).toBe(0);
      damage(indexDir(root, first.generation as string));
      const after = await ask(root);
      expect(after.cacheHits).toBeGreaterThan(0);
      const fresh = await ask(root, { full: true });
      // The damaged build is not used again; the build that replaced it answers.
      expect(after.generation).not.toBe(first.generation);
      expect(after.answers).toEqual(fresh.answers);
      const unbuilt = (a: string) => JSON.stringify({ ...JSON.parse(a), graph: null });
      expect(after.answers.map(unbuilt)).toEqual(loaded.answers.map(unbuilt));
    });
  }

  it("does not load the old index after an edit adds a caller (4)", async () => {
    const root = repo();
    await ask(root);
    writeFiles(root, { "src/extra.ts": 'import { log } from "./store";\nexport function extra(): void {\n  log(3);\n}\n' });
    const after = await ask(root);
    expect(JSON.parse(after.answers[0] as string).items.map((i: { site: { file: string } }) => i.site.file)).toContain("src/extra.ts");
  });

  it("builds from facts when the question compares with the base or is forced fresh (5)", async () => {
    const root = repo();
    await ask(root);
    await ask(root);
    const forced = await ask(root, { full: true });
    expect(forced.cacheHits).toBeGreaterThan(0);
    const pinned = await pinWorkTree({ repoRoot: root, store: await storeOf(root), settings, purpose: "cli", compare: { exclude: [] } });
    try {
      expect(pinned.session.graph.status.cacheHits).toBeGreaterThan(0);
    } finally {
      pinned.release();
    }
  });
});
