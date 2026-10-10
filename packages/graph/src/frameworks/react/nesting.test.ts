// Every fact reader of the Express, React, Next.js, FastAPI and Go net/http
// plugins on code nested tens of thousands of levels deep. A reader that
// asks a node for its parent pays for a walk from the root each time
// (tree-sitter keeps no parent pointers), so it turns quadratic on such a
// file: the React reader once took forty seconds on 20,000 nested blocks.
// The readers keep their ancestors on stacks instead; this test holds them
// to that. The smaller input is read as many times over as it takes to pass
// the noise floor (expectLinearRepeated): read once, a quarter of the depth
// costs a few milliseconds, and a quadratic reader at the full depth still
// fits eight times the floor (issue #101: 5,000 nested elements, 105 ms).
import { describe, it } from "vitest";
import type { Node } from "web-tree-sitter";
import { expectLinearRepeated, readerCpuMs } from "../../test-timing.js";
import type { Lang } from "../../types.js";
import { express } from "../express/index.js";
import { fastapi } from "../fastapi/index.js";
import { goHttp } from "../go-http/index.js";
import { nextjs } from "../nextjs/index.js";
import type { FrameworkFactBase, FrameworkPlugin } from "../plugin.js";
import { react } from "./index.js";

const N = 20_000;
// Each language's source at nesting depth `n`; the test reads N and a quarter of it.
const SOURCES: Record<"typescript" | "tsx" | "python" | "go", (n: number) => string> = {
  typescript: (n) => `export function f() {}\n${"{ f(); ".repeat(n)}${"}".repeat(n)}\n`,
  tsx: (n) => `export function App() {\n  return ${"<div>".repeat(n / 4)}x${"</div>".repeat(n / 4)};\n}\n${"(() => ".repeat(n / 4)}0${")".repeat(n / 4)};\n`,
  python: (n) => `def f(x):\n    return x\n\ny = ${"f(".repeat(n / 4)}0${")".repeat(n / 4)}\nz = ${"[".repeat(n / 4)}${"]".repeat(n / 4)}\n`,
  go: (n) => `package main\n\nfunc f() {}\n\nfunc g() {\n${"{ f(); ".repeat(n)}${"}".repeat(n)}\n}\n`,
};

const plugins = [express, react, nextjs, fastapi, goHttp] as FrameworkPlugin<FrameworkFactBase>[];

describe("the fact readers on deeply nested code", () => {
  for (const plugin of plugins) {
    for (const lang of Object.keys(SOURCES) as (keyof typeof SOURCES)[]) {
      if (!plugin.languages.includes(lang as Lang)) continue;
      it(`the ${plugin.id} reader reads ${lang} nested thousands of levels deep in time that grows with the depth, so nesting cannot make it quadratic`, async () => {
        const read = (root: Node) => plugin.facts(root, lang as Lang);
        const at = (n: number) => (repeats: number) => readerCpuMs(lang as Lang, Array<string>(repeats).fill(SOURCES[lang](n)), read);
        await expectLinearRepeated(`the ${plugin.id} reader on ${lang} nested ${N / 4} and ${N} deep`, at(N / 4), at(N), { maxRepeats: 16 });
      });
    }
  }
});
