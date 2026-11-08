import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { extract } from "../src/extract.js";
import { parserFor } from "../src/parser.js";

async function factsOf(lang: "java" | "python", source: string) {
  const parser = await parserFor(lang);
  const tree = parser.parse(source);
  if (!tree) throw new Error("no tree");
  try {
    return extract(tree, lang);
  } finally {
    tree.delete();
    parser.delete();
  }
}

it("drops a loop-reassigned alias without invalidating a Python alias shadowed by a nested function", async () => {
  const java = await factsOf("java", [
    "class Host {",
    "  void refresh() {}",
    "  void replacement() {}",
    "  void use() {",
    "    Runnable r = this::refresh;",
    "    for (int i = 0; i < 1; i++) {",
    "      r = this::replacement;",
    "    }",
    "    r.run();",
    "  }",
    "}",
  ].join("\n"));
  const run = java.calls.find((call) => call.name === "run");
  expect(run).toBeDefined();
  expect(run).not.toHaveProperty("alias");

  const source = readFileSync(new URL("../corpus/python/values/value-alias/base/pkg/run.py", import.meta.url), "utf8");
  const python = await factsOf("python", source);
  const outer = python.calls.find((call) => call.name === "cb" && python.defs[call.caller]?.name === "outer");
  expect(outer).toHaveProperty("alias", expect.any(Number));
  expect(python.values[outer!.alias!]).toMatchObject({ name: "helper", role: "assign", line: 14 });
});
