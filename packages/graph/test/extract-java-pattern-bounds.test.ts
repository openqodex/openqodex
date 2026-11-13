import { expect, it } from "vitest";
import { extract } from "../src/extract.js";
import { parserFor } from "../src/parser.js";
import { isFileFacts } from "../src/safe-fs.js";

it("prevents quadratic survival scans in Java loops without patterns", async () => {
  const count = 2000;
  const source = `class Loops { void run(boolean flag) { ${"while (flag) {".repeat(count)} ${"}".repeat(count)} } void done() {} }`;
  const parser = await parserFor("java");
  const tree = parser.parse(source);
  if (!tree) throw new Error("no tree");
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const facts = extract(tree, "java");
    const serialized = JSON.stringify(facts);
    expect(facts.defs.map((d) => d.name)).toEqual(["Loops", "run", "done"]);
    expect(Buffer.byteLength(serialized)).toBeLessThan(64 * 1024);
    expect(isFileFacts(JSON.parse(serialized))).toBe(true);
  } finally {
    tree.delete();
    parser.delete();
  }
});

// Failure: a loop body past the node cap makes the survival scan give up, and
// giving up must never keep the negated pattern bound after the loop.
it("leaves a negated pattern unbound after a while loop whose body is past the survival scan cap", async () => {
  const run = async (statements: number) => {
    const source = `class Loops { void run(Object o, int n) { while (!(o instanceof String s)) { ${"n++;".repeat(statements)} } s.length(); } }`;
    const parser = await parserFor("java");
    const tree = parser.parse(source);
    if (!tree) throw new Error("no tree");
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const call = extract(tree, "java").calls.find((c) => c.name === "length");
      if (!call) throw new Error("no call");
      return call.recv;
    } finally {
      tree.delete();
      parser.delete();
    }
  };
  const small = await run(3);
  expect(small.kind).toBe("type");
  if (small.kind === "type") expect(small.type.name).toBe("String");
  const capped = await run(3000);
  expect(capped.kind).not.toBe("type");
});
