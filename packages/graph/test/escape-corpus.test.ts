// The escape oracle (test 14 of the list floor plan): a function escapes by
// a path the graph does not see, and its caller list reads as whole.
//
// Ways it could fail, written before the code:
//  1. A call that really runs the target is missing from `graph callers`
//     and the answer says the list is whole (unknown.floor false). Each
//     case's `mustReach` rows are written by hand from reading the code,
//     never from graph output; a row passes when the caller is listed at
//     any tier at the row's file and line, or the list is a floor.
//  2. A target no hidden path can reach is still a floor, so agents learn
//     to ignore the warning (`whole` rows).
//  3. A floor says a reason that does not name the escape, or names the
//     wrong place (`floored` rows: a reason holding the text, at the place,
//     where `a.ts:2` does not match `a.ts:20`).
//  4. A value use is the floor's reason but `graph references` does not
//     list it, so the agent sent to read the use cannot find it (each
//     `floored` row whose reason is a value use outside the target's own
//     body: the references answer lists a use at that place; a use in its
//     own body is no edge, as a self call is none).
//  5. A resolver change drops the value-use count of a function a value
//     may call: a may_invoke edge into a symbol whose count is zero (14b, a
//     consistency check, never a proof that the reader sees every use).
//  6. A floor reads "complete in product code" though product code may run
//     the hidden caller (a `floored` row's `scope`, when it has one).
//
// Each case is one JSON file in escape-corpus/: the files of a small repo,
// what it covers, and its rows. The files are kept as data, not as source
// files of this repository, so the graph of this repository never reads an
// eval or a computed load written only to test the floor. A new escape path
// gets a case here before its fix.
import { afterAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Answer, Request, Session } from "../src/query/answer.js";
import { makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

type Row = { target: string; caller: string | null; file: string; line: number };
type Case = { covers: string; files: Record<string, string>; mustReach: Row[]; whole: string[]; floored: { target: string; reason: string; at: string; scope?: "tests" | "all" }[] };

const dir = join(dirname(fileURLToPath(import.meta.url)), "escape-corpus");
const cases = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ name: f.replace(/\.json$/, ""), spec: JSON.parse(readFileSync(join(dir, f), "utf8")) as Case }));

// "file#name" or "file#Owner.name" to the one symbol it names.
const idOf = (g: Graph, target: string): string => {
  const [file, qualified] = target.split("#") as [string, string];
  const dot = qualified.lastIndexOf(".");
  return dot < 0 ? symbol(g, file, qualified) : symbol(g, file, qualified.slice(dot + 1), qualified.slice(0, dot));
};

const ask = (g: Graph, kind: "callers" | "references", id: string): Answer => {
  const s: Session = { graph: g, generation: "test-build", treeSha: null, builtAt: null, laterEditsKnown: false };
  return query(s, { apiVersion: 1, kind, target: { id }, depth: 1, limit: 500 } as Request);
};
const callersOf = (g: Graph, id: string): Answer => ask(g, "callers", id);

describe("the escape corpus", () => {
  const graphs = new Map<string, Promise<Graph>>();
  const graphOf = (name: string, files: Record<string, string>) => {
    let g = graphs.get(name);
    if (!g) graphs.set(name, (g = buildGraph({ repoRoot: makeRepo(files), store: null })));
    return g;
  };

  for (const { name, spec } of cases) {
    it(`keeps every hidden caller on a floor and clears the whole ones: ${spec.covers} (${name})`, async () => {
      const g = await graphOf(name, spec.files);
      for (const row of spec.mustReach) {
        const id = idOf(g, row.target);
        const callerId = row.caller === null ? null : row.caller.includes("#") ? idOf(g, row.caller) : row.caller;
        const a = callersOf(g, id);
        // Listed at the row's own place: an edge from the caller elsewhere
        // would hide a call missing here.
        const listed = callerId !== null && (a.items as { from: string; site: { file: string; line: number } }[]).some((i) => i.from === callerId && i.site.file === row.file && i.site.line === row.line);
        expect(listed || a.unknown.floor, `${row.target} is called from ${row.caller ?? "outside the repository"} at ${row.file}:${row.line}; reasons: ${a.unknown.reasons.join("; ")}`).toBe(true);
      }
      for (const target of spec.whole) {
        const a = callersOf(g, idOf(g, target));
        expect(a.unknown.floor, `${target} should be whole; reasons: ${a.unknown.reasons.join("; ")}`).toBe(false);
      }
      for (const f of spec.floored) {
        const a = callersOf(g, idOf(g, f.target));
        expect(a.unknown.floor, f.target).toBe(true);
        // The place with a boundary on each side: `a.ts:2` is not `a.ts:20` nor `lib/a.ts:2`.
        const literal = f.at.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const place = new RegExp(`(?<![\\w./-])${literal}(?!\\d)`);
        const hit = a.unknown.reasons.find((r) => r.includes(f.reason) && (f.at === "" || place.test(r)));
        expect(hit, `${f.target}: a reason with "${f.reason}" at ${f.at || "any place"}; got: ${a.unknown.reasons.join("; ")}`).toBeDefined();
        // Where a hidden caller could be, when the row says.
        if (f.scope) expect(a.unknown.scope, `${f.target}: scope; note: ${a.unknown.note ?? "none"}`).toBe(f.scope);
        const [file, line] = f.at.split(":") as [string, string];
        const self = g.nodes.get(idOf(g, f.target));
        const inOwnBody = self !== undefined && self.file === file && Number(line) >= self.startLine && Number(line) <= self.endLine;
        if (hit?.startsWith("it is used as a value") && f.at !== "" && !inOwnBody) {
          const listed = (ask(g, "references", idOf(g, f.target)).items as { site: { file: string; line: number } }[]).map((i) => `${i.site.file}:${i.site.line}`);
          expect(listed, `${f.target}: graph references lists the use at ${f.at}`).toContain(f.at);
        }
      }
    }, 60_000);
  }

  it("counts a value use for every function a value may call: a consistency check, not a proof of completeness (14b)", async () => {
    for (const { name, spec } of cases) {
      const g = await graphOf(name, spec.files);
      for (const e of g.edges) {
        if (e.kind !== "may_invoke") continue;
        expect(g.escapes.uses.get(e.to)?.count ?? 0, `${name}: ${e.to}`).toBeGreaterThan(0);
      }
    }
  }, 120_000);
});
