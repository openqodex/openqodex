import { expect, it } from "vitest";
import { extract } from "../src/extract.js";
import { parserFor } from "../src/parser.js";
import { isFileFacts } from "../src/safe-fs.js";

it("prevents exponential facts from repeated Java type parameter bounds", async () => {
  const count = 16;
  const width = 4;
  const parameters = Array.from({ length: count }, (_, i) => {
    const args = i === 0 ? "Z" : Array.from({ length: width }, () => `P${i - 1}`).join(",");
    return `P${i} extends Y<${args}>`;
  });
  const fields = Array.from({ length: count }, (_, i) => `P${i} f${i};`);
  const source = `class X<${parameters.join(",")}> { ${fields.join(" ")} }`;
  expect(Buffer.byteLength(source)).toBeLessThan(1024);
  const parser = await parserFor("java");
  const tree = parser.parse(source);
  if (!tree) throw new Error("no tree");
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const facts = extract(tree, "java");
    const serialized = JSON.stringify(facts);
    expect(Buffer.byteLength(serialized)).toBeLessThan(64 * 1024);
    expect(Object.keys(facts.defs[0]!.fields)).toHaveLength(count);
    expect(facts.defs[0]!.fields.f15).toMatchObject({ name: "Y" });
    expect(isFileFacts(JSON.parse(serialized))).toBe(true);
  } finally {
    tree.delete();
    parser.delete();
  }
});
