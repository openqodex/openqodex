// Gaps a review of the list floor found, each written to fail before its fix.
//
// Ways it could fail, written before the code:
//  1. A callers answer two hops deep says "complete in product code" from
//     the floor of the first hop alone, though a caller of a caller may
//     hide in product code.
//  2. A file that reads more distinct free names than the facts check
//     admits writes facts that never pass it, so every build parses the
//     file again and the graph reads it as unreadable.
//  3. The cap on declaration files counts only the files that declare
//     something, so a repository with many other `.d.ts` files has every
//     one of them read.
//  4. `typeof import("./m").ns.x` records a type use of `ns` in m that the
//     code never makes, though `typeof import("./m").ns` records none.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, extractFacts } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Answer, Request, Session } from "../src/query/answer.js";
import { isFileFacts } from "../src/safe-fs.js";
import { makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

async function sessionOf(files: Record<string, string>): Promise<Session> {
  const graph = await buildGraph({ repoRoot: makeRepo(files), store: null });
  return { graph, generation: "test-build", treeSha: null, builtAt: null, laterEditsKnown: false };
}
const ask = (s: Session, req: Omit<Request, "apiVersion">): Answer => query(s, { apiVersion: 1, ...req } as Request);

describe("gaps a review of the list floor found", () => {
  it("scopes a deeper callers answer to tests only when every hop's floor is (1)", async () => {
    const s = await sessionOf({
      "app/package.json": '{"name": "app"}\n',
      "app/a.ts": "export function f() {}\n",
      "app/b.ts": 'import { f } from "./a";\nexport function h() {\n  f();\n}\n',
      "app/a.test.ts": 'import { f } from "./a";\nexport const v = X1;\nf();\n',
      "app/c.ts": 'import { h } from "./b";\nexport const v = X3;\nh();\n',
    });
    const one = ask(s, { kind: "callers", target: { name: "f", file: "app/a.ts" }, depth: 1 });
    expect(one.unknown.floor).toBe(true);
    expect(one.unknown.scope).toBe("tests");
    const two = ask(s, { kind: "callers", target: { name: "f", file: "app/a.ts" }, depth: 2 });
    expect(two.unknown.floor).toBe(true);
    expect(two.unknown.scope).toBe("all");
  }, 60_000);

  it("writes facts that pass the facts check for a file with more than 4,096 free names (2)", async () => {
    const names = Array.from({ length: 4200 }, (_, i) => `G${i}`);
    const facts = await extractFacts("javascript", `export const all = [${names.join(", ")}];\n`);
    expect(facts?.opaque?.length ?? 0).toBeGreaterThan(4096);
    expect(isFileFacts(JSON.parse(JSON.stringify(facts)))).toBe(true);
  }, 60_000);

  it("stops reading declaration files at the cap, counting the files that declare nothing (3)", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "app", private: true, type: "module" }),
      "src/a.ts": "export function f() {}\n",
      "src/b.ts": 'import { f } from "./a";\nexport const v = V;\nf();\n',
      "types/zz.d.ts": "declare const V: string;\n",
    };
    for (let i = 0; i < 500; i++) files[`types/t${String(i).padStart(3, "0")}.d.ts`] = `export interface T${i} {\n  id: string;\n}\n`;
    const s = await sessionOf(files);
    // The 501st declaration file is past the cap: V is not known as a string.
    const a = ask(s, { kind: "callers", target: { name: "f", file: "src/a.ts" } });
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.reasons.join(" ")).toContain("reads the free name `V`");
  }, 120_000);

  it("records no type use of a namespace read through `typeof import()` (4)", async () => {
    const s = await sessionOf({
      "package.json": JSON.stringify({ name: "app", private: true, type: "module" }),
      "src/m.ts": "export class ns {\n  static x = 1;\n}\n",
      "src/a.ts": 'export type T = typeof import("./m").ns.x;\nexport type U = typeof import("./m").ns;\n',
    });
    const refs = ask(s, { kind: "references", target: { id: symbol(s.graph, "src/m.ts", "ns") } });
    const sites = (refs.items as { kind: string; site: { file: string; line: number } }[]).map((i) => `${i.kind} ${i.site.file}:${i.site.line}`);
    expect(sites).not.toContain("uses_type src/a.ts:1");
  }, 60_000);
});
