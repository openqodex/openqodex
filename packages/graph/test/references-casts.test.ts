// `references` of a type named only in a cast. Ways it could fail, written
// before the code:
//  1. A TypeScript angle-bracket cast (`<Row>x`) names the type and has no
//     row: the file imports the type, so the list says it may be short,
//     and the use itself is never shown.
//  2. A cast to an import type (`x as import("./types").Row`, also with an
//     array suffix) has no row: the module the import type names is never
//     read as an import, so the name binds to nothing.
//  3. The import type binds by its name alone, not by the module it names:
//     a same-named type of another folder is linked.
//  4. In a .tsx file, where `<Row>x` is not a cast, a cast written with
//     `as` stops being read, or a JSX element is taken for a cast.
//  5. A Python `typing.cast(Foo, x)` or `cast("Foo", x)` has no row; or
//     one written with keywords (`cast(typ=Foo, val=x)`) has none; or a
//     parameter or local named `cast` or `typing`, which hides the import,
//     is read as the typing module's and gives a row it does not make.
//  6. A Go type assertion (`v.(Bar)`, `v.(*Bar)`, `v.(store.Bar)`) has no row.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Answer, Item, Request, Session } from "../src/query/engine.js";
import { at, makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "app", private: true, type: "module" }),
  "src/types.ts": "export interface Row {\n  id: string;\n}\n",
  "src/angle.ts": ['import type { Row } from "./types";', "", "export function one(x: unknown): unknown {", "  return <Row>x; // angle-cast", "}", ""].join("\n"),
  "src/importcast.ts": [
    "export function two(x: unknown): unknown {",
    '  return x as import("./types").Row; // import-as',
    "}",
    "",
    "export function three(x: unknown): unknown {",
    "  return <import('./types').Row>x; // import-angle",
    "}",
    "",
    'export function four(r: import("./types").Row): string { // import-param',
    "  return r.id;",
    "}",
    "",
    // The grammar reads this one with a missing node (grammar-gaps.test.ts).
    "export function six(x: unknown): unknown {",
    "  return x as import('./types').Row[]; // import-array",
    "}",
    "",
  ].join("\n"),
  // The same name in another folder: its import type binds to its own module.
  "src/other/types.ts": "export interface Row {\n  other: number;\n}\n",
  "src/other/cast.ts": ["export function five(x: unknown): unknown {", '  return x as import("./types").Row; // other-import-as', "}", ""].join("\n"),
  "src/view.tsx": [
    'import type { Row } from "./types";',
    "",
    "export function View(p: { x: unknown }) {",
    "  return <div>{String((p.x as Row).id)}</div>; // tsx-as",
    "}",
    "",
  ].join("\n"),
  "py/pyproject.toml": '[project]\nname = "app"\n',
  "py/models.py": "class Foo:\n    pass\n",
  "py/use.py": [
    "import typing",
    "from typing import cast",
    "from models import Foo",
    "",
    "",
    "def by_name(x):",
    "    return cast(Foo, x)  # py-cast",
    "",
    "",
    "def by_string(x):",
    '    return cast("Foo", x)  # py-cast-string',
    "",
    "",
    "def by_module(x):",
    "    return typing.cast(Foo, x)  # py-typing-cast",
    "",
    "",
    "def by_keyword(x):",
    "    return cast(val=x, typ=Foo)  # py-cast-keyword",
    "",
    "",
    "def shadowed(cast, x):",
    "    return cast(Foo, x)  # py-shadowed-cast",
    "",
    "",
    "def shadowed_module(typing, x):",
    "    return typing.cast(Foo, x)  # py-shadowed-module",
    "",
  ].join("\n"),
  "go/go.mod": "module example.com/m\n\ngo 1.22\n",
  "go/store/store.go": "package store\n\ntype Bar struct{ ID string }\n",
  "go/store/same.go": ["package store", "", "func Same(v any) any {", "\treturn v.(Bar) // go-assert", "}", "", "func Ptr(v any) any {", "\treturn v.(*Bar) // go-assert-ptr", "}", ""].join("\n"),
  "go/cmd/main.go": ['package main', "", 'import "example.com/m/store"', "", "func Other(v any) any {", "\treturn v.(store.Bar) // go-assert-pkg", "}", "", "func main() {}", ""].join("\n"),
};

describe("references of a type named only in a cast", () => {
  let s: Session;
  let graph: Graph;
  beforeAll(async () => {
    graph = await buildGraph({ repoRoot: makeRepo(files), store: null });
    s = { graph, generation: "refs-casts", treeSha: null, builtAt: null, laterEditsKnown: false };
  }, 60_000);
  const q = (req: Omit<Request, "apiVersion">): Answer => query(s, { apiVersion: 1, ...req } as Request) as Answer;
  const rows = (file: string, name: string) =>
    (q({ kind: "references", target: { id: symbol(graph, file, name) } }).items as Item[]).map((i) => [`${i.site.file}:${i.site.line}`, i.kind]);

  it("lists a TypeScript angle-bracket cast, and the file that imports the type is not left unread (1)", () => {
    expect(rows("src/types.ts", "Row")).toContainEqual([at(files, "src/angle.ts", "angle-cast"), "uses_type"]);
    const a = q({ kind: "references", target: { id: symbol(graph, "src/types.ts", "Row") } });
    expect(a.unknown.reasons.join(" ")).not.toContain("src/angle.ts");
  });

  it("lists a cast to an import type, with as, angle brackets or an array suffix, and a parameter typed by one (2)", () => {
    const r = rows("src/types.ts", "Row");
    for (const marker of ["import-as", "import-angle", "import-param", "import-array"]) expect(r).toContainEqual([at(files, "src/importcast.ts", marker), "uses_type"]);
  });

  it("binds an import type through the module it names, not by its name (3)", () => {
    expect(rows("src/types.ts", "Row").map((r) => r[0])).not.toContain(at(files, "src/other/cast.ts", "other-import-as"));
    expect(rows("src/other/types.ts", "Row")).toEqual([[at(files, "src/other/cast.ts", "other-import-as"), "uses_type"]]);
  });

  it("reads a cast written with as in a .tsx file, and no JSX element as a cast (4)", () => {
    const r = rows("src/types.ts", "Row").filter((x) => String(x[0]).startsWith("src/view.tsx"));
    expect(r).toEqual([[at(files, "src/view.tsx", "tsx-as"), "uses_type"]]);
  });

  it("lists a Python typing.cast by name, by string, through the module and by keyword (5)", () => {
    const r = rows("py/models.py", "Foo");
    for (const marker of ["py-cast", "py-cast-string", "py-typing-cast", "py-cast-keyword"]) expect(r).toContainEqual([at(files, "py/use.py", marker), "uses_type"]);
  });

  it("lists no Python cast where a parameter hides the typing import (5)", () => {
    const r = rows("py/models.py", "Foo").filter((x) => x[1] === "uses_type").map((x) => x[0]);
    for (const marker of ["py-shadowed-cast", "py-shadowed-module"]) expect(r).not.toContain(at(files, "py/use.py", marker));
  });

  it("lists a Go type assertion to the type, its pointer and the type of another package (6)", () => {
    const r = rows("go/store/store.go", "Bar");
    for (const [file, marker] of [["go/store/same.go", "go-assert"], ["go/store/same.go", "go-assert-ptr"], ["go/cmd/main.go", "go-assert-pkg"]] as const) {
      expect(r).toContainEqual([at(files, file, marker), "uses_type"]);
    }
  });
});
