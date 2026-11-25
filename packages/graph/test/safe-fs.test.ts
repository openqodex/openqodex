import { expect, it } from "vitest";
import { extract } from "../src/extract.js";
import { parserFor } from "../src/parser.js";
import { isFileFacts } from "../src/safe-fs.js";
import { MAX_TYPE_DEPTH } from "../src/types.js";

it.each(["promise", "awaited"])("refuses a cached TypeRef with a non-boolean %s flag", async (flag) => {
  const parser = await parserFor("typescript");
  const tree = parser.parse("export async function find(): Promise<Item> { return new Item(); }");
  if (!tree) throw new Error("no tree");
  const facts = extract(tree, "typescript");
  const result = facts.defs.find((d) => d.name === "find")?.results?.[0];
  expect(result).toBeDefined();
  expect(isFileFacts(facts)).toBe(true);
  Object.assign(result as object, { [flag]: "x" });
  expect(isFileFacts(facts)).toBe(false);
});

// Cached arguments must keep their positions, types and shared nesting bound.
it.each([
  ["non-array arguments", { args: "Repo" }],
  ["invalid argument type", { args: [{ name: 1 }] }],
  ["negative parameter index", { param: -1 }],
  ["fractional parameter index", { param: 0.5 }],
])("refuses cached Java types with %s", async (_name, invalid) => {
  const parser = await parserFor("java");
  const tree = parser.parse("class Box { Repo get() { return null; } }");
  if (!tree) throw new Error("no tree");
  const facts = extract(tree, "java");
  const result = facts.defs.find((d) => d.name === "get")?.results?.[0];
  expect(result).toBeDefined();
  Object.assign(result as object, invalid);
  expect(isFileFacts(facts)).toBe(false);
  tree.delete();
  parser.delete();
});

it("caps extracted Java arguments and refuses cached arguments past the shared type depth", async () => {
  const parser = await parserFor("java");
  const nested = "Box<".repeat(MAX_TYPE_DEPTH + 3) + "Repo" + ">".repeat(MAX_TYPE_DEPTH + 3);
  const tree = parser.parse(`class Host { ${nested} field; }`);
  if (!tree) throw new Error("no tree");
  const facts = extract(tree, "java");
  expect(isFileFacts(facts)).toBe(true);
  const ref = { name: "Box", qualifier: null, line: 1, column: 1 };
  let type: object = ref;
  for (let i = 0; i <= MAX_TYPE_DEPTH; i++) type = { ...ref, args: [type] };
  Object.assign(facts.defs[0]!.fields, { field: type });
  expect(isFileFacts(facts)).toBe(false);
  tree.delete();
  parser.delete();
});

// A file of many loads by a computed path is read back from the cache, not
// dropped as unreadable; and a cached plain-type list that is no list of
// names is refused, since the resolver reads it as one.
const keyedFacts = async () => {
  const parser = await parserFor("typescript");
  const tree = parser.parse("export function read(n: number, k: number): unknown {\n  return n[k];\n}\nrequire(globalThis.x);\n");
  if (!tree) throw new Error("no tree");
  const facts = extract(tree, "typescript");
  tree.delete();
  parser.delete();
  return facts;
};

it("keeps cached facts with more than 20,000 escapes", async () => {
  const facts = await keyedFacts();
  const load = facts.escapes?.find((e) => e.kind === "load");
  expect(load).toBeDefined();
  facts.escapes = Array.from({ length: 20_001 }, (_, i) => ({ ...(load as object), line: i + 1 }) as typeof load & object);
  expect(isFileFacts(facts)).toBe(true);
});

it("refuses a cached looseMembers plain that is no list of names", async () => {
  const facts = await keyedFacts();
  const member = facts.looseMembers?.find((m) => m.plain !== undefined);
  expect(member).toBeDefined();
  expect(isFileFacts(facts)).toBe(true);
  Object.assign(member as object, { plain: "Number" });
  expect(isFileFacts(facts)).toBe(false);
});
