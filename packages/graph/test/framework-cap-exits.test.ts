// A framework plugin's build-wide caps stop work in many places but say so
// through one table each, and the callers floor reads what that table
// says. The escape corpus trips one cap of each table end to end; this
// file proves the rest of each table. Ways it could fail, written before
// the code:
//  1. A row of the FastAPI or Nest table records an unknown the callers
//     floor does not read (a data relation, a cause it skips), so a
//     handler past that cap reads as having no caller.
//  2. A FastAPI cap first reached with no site says nothing (the table
//     skipped a cap whose first site was null).
//  3. The stage's per-application caps drop the entities no application
//     reaches and say so for the root project only, so a handler in a
//     sub-project past the cap reads as having no caller.
import { describe, expect, it } from "vitest";
import type { Graph } from "../src/index.js";
import type { Entity, FrameworkEdge, FrameworkUnknown } from "../src/frameworks/plugin.js";
import { capPerApp, MAX_EDGES_PER_APP, MAX_ENTITIES_PER_APP } from "../src/frameworks/stage.js";
import { EXITS as FASTAPI_EXITS, capUnknowns } from "../src/frameworks/fastapi/resolve.js";
import type { Cap } from "../src/frameworks/fastapi/resolve.js";
import { EXITS as NEST_EXITS, budgetUnknowns } from "../src/frameworks/nest/resolve.js";
import { frameworkCallerGaps } from "../src/query/frameworks.js";

// The framework floor of a function in `file`, given only these unknowns;
// every file under sub/ is the project "sub", the rest the root project "".
const floorOn = (unknowns: FrameworkUnknown[], file: string) => {
  const g = { frameworks: { entities: [], edges: [], unknowns, plugins: [], apps: [] }, projectOf: (f: string) => (f.startsWith("sub/") ? "sub" : "") } as unknown as Graph;
  return frameworkCallerGaps(g, file);
};

describe("each build-wide cap of a framework plugin floors the callers it may hide", () => {
  it("floors a handler in any project for every row of the FastAPI cap table, a cap first reached with no site too (1, 2)", () => {
    const keys = Object.keys(FASTAPI_EXITS) as (keyof typeof FASTAPI_EXITS)[];
    for (const k of keys) {
      for (const first of [{ file: "app.py", line: 3, column: 1 }, null]) {
        const caps = Object.fromEntries(keys.map((j) => [j, { used: 0, max: FASTAPI_EXITS[j].max, first, left: j === k ? 1 : 0, exact: true }])) as Record<keyof typeof FASTAPI_EXITS, Cap>;
        const said = capUnknowns(caps);
        expect(said, k).toHaveLength(1);
        for (const file of ["app.py", "sub/h.py"]) expect(floorOn(said, file).gaps, `${k} at ${first ? "a site" : "no site"}, asked in ${file}`).not.toEqual([]);
      }
    }
  });

  it("floors a handler in any project for every row of the Nest budget table (1)", () => {
    const keys = Object.keys(NEST_EXITS) as (keyof typeof NEST_EXITS)[];
    for (const k of keys) {
      const said = budgetUnknowns(Object.fromEntries(keys.map((j) => [j, j === k ? 1 : 0])) as Record<keyof typeof NEST_EXITS, number>);
      expect(said, k).toHaveLength(1);
      for (const file of ["src/a.controller.ts", "sub/src/b.controller.ts"]) expect(floorOn(said, file).gaps, `${k}, asked in ${file}`).not.toEqual([]);
    }
  });

  it("floors a handler in a sub-project when the stage drops entities or edges no application reaches (3)", () => {
    const site = { file: "sub/src/c.ts", line: 1, column: 1 };
    const entities = Array.from({ length: MAX_ENTITIES_PER_APP + 1 }, (_, i) => ({ kind: "registration", id: `e${i}`, plugin: "nest", app: null, site }) as unknown as Entity);
    const unknowns: FrameworkUnknown[] = [];
    capPerApp("nest", entities, [], unknowns);
    expect(unknowns.map((u) => u.count)).toEqual([1]);
    expect(floorOn(unknowns, "sub/src/c.ts").gaps).not.toEqual([]);

    const edges = Array.from({ length: MAX_EDGES_PER_APP + 1 }, (_, i) => ({ from: "r", to: `t${i}`, kind: "handles", plugin: "nest", app: null }) as unknown as FrameworkEdge);
    const edgeUnknowns: FrameworkUnknown[] = [];
    capPerApp("nest", [], edges, edgeUnknowns);
    expect(edgeUnknowns.map((u) => u.count)).toEqual([1]);
    expect(floorOn(edgeUnknowns, "sub/src/c.ts").gaps).not.toEqual([]);
  });
});
