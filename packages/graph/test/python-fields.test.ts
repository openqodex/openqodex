// Python field assignments whose type is unknown must not leave an earlier
// known type on the field:
// 1. Assigning an untyped parameter or expression after a known type clears
//    the field's type, so a call on it never binds certain to the old class.
// 2. Assigning an unknown value before a known type leaves the field untyped
//    regardless of method order.
// 3. A declared field annotation stands even when a method assigns an unknown
//    value, in either order.
// 4. Assigning the same known type in more than one method keeps that type.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

async function graphOf(files: Record<string, string>): Promise<Graph> {
  return buildGraph({ repoRoot: makeRepo(files), store: null });
}

function certainSites(graph: Graph, id: string): string[] {
  return (graph.in.get(id) ?? [])
    .filter((e) => e.kind === "calls" || e.kind === "dispatches_to")
    .flatMap((e) => e.sites.filter((s) => s.tier === "certain").map((s) => `${s.file}:${s.line}`))
    .sort();
}

const STORE = [
  "class Store:",
  "    def get(self, key):",
  "        return key",
  "",
].join("\n");

describe("Python field typing with unknown assignments", () => {
  it("clears a field's known type when another assignment has unknown type (1, 2)", async () => {
    const graph = await graphOf({
      "pkg/__init__.py": "",
      "pkg/store.py": STORE,
      "pkg/service.py": [
        "from .store import Store",
        "",
        "class KnownThenUnknown:",
        "    def __init__(self):",
        "        self.store = Store()",
        "",
        "    def swap(self, other):",
        "        self.store = other",
        "",
        "    def run(self, key):",
        "        return self.store.get(key)",
        "",
        "class UnknownThenKnown:",
        "    def swap(self, items):",
        "        self.store = items[0]",
        "",
        "    def __init__(self, store: Store):",
        "        self.store = store",
        "",
        "    def run(self, key):",
        "        return self.store.get(key)",
        "",
        "class KnownThenCallExpr:",
        "    def __init__(self, store: Store):",
        "        self.store = store",
        "",
        "    def swap(self, factory):",
        "        self.store = factory()()",
        "",
        "    def run(self, key):",
        "        return self.store.get(key)",
        "",
      ].join("\n"),
    });

    const get = symbol(graph, "pkg/store.py", "get", "Store");
    expect(certainSites(graph, get)).toEqual([]);
    const unknowns = graph.unknowns
      .filter((u) => u.file === "pkg/service.py" && u.cause === "no-receiver-type")
      .map((u) => u.line)
      .sort((a, b) => a - b);
    expect(unknowns).toEqual([11, 21, 31]);
  });

  it("keeps a declared field type and a consistent known type across assignments (3, 4)", async () => {
    const graph = await graphOf({
      "pkg/__init__.py": "",
      "pkg/store.py": STORE,
      "pkg/service.py": [
        "from .store import Store",
        "",
        "class DeclaredFirst:",
        "    store: Store",
        "",
        "    def swap(self, other):",
        "        self.store = other",
        "",
        "    def run(self, key):",
        "        return self.store.get(key)",
        "",
        "class DeclaredLater:",
        "    def swap(self, other):",
        "        self.store = other",
        "",
        "    def __init__(self, other):",
        "        self.store: Store = other",
        "",
        "    def run(self, key):",
        "        return self.store.get(key)",
        "",
        "class SameKnownType:",
        "    def __init__(self, store: Store):",
        "        self.store = store",
        "",
        "    def reset(self):",
        "        self.store = Store()",
        "",
        "    def run(self, key):",
        "        return self.store.get(key)",
        "",
      ].join("\n"),
    });

    const get = symbol(graph, "pkg/store.py", "get", "Store");
    expect(certainSites(graph, get)).toEqual([
      "pkg/service.py:10",
      "pkg/service.py:20",
      "pkg/service.py:30",
    ]);
  });
});
