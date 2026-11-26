// One fixture per review limit, sitting just over it, with what happens
// asserted, and the same fixture one step under it for contrast. Each
// fixture is found by growing one size a step at a time until the limit
// first bites, so a change to how a part or a packet is rendered moves the
// step, not the test.
//
// These are unit tests, not golden cases: golden reviews one planted demo
// change with stand-in reviewers, so each limit would need its own planted
// change and hundreds of KB of saved briefs. Here each limit's own code runs
// directly, with no model.
//
// Ways it could fail, written before the code:
//  1. NEIGHBOURHOOD_MAX_BYTES: one linked symbol over the packet cap writes
//     a packet over 64 KB, cuts more than the one symbol, or cuts it without
//     saying so.
//  2. NEIGHBOURHOOD_TIME_MS: a scan that reaches the time cap is not marked
//     partial with cause time, or one a millisecond under it is.
//  3. MAX_UNIT_DIFF_BYTES: a range one row over 120 KB stays one part over
//     the cap, or loses a row when cut.
//  4. MAX_BRIEF_BYTES: fixed blocks that put a 120 KB part just over the
//     brief bound leave that part unread instead of cutting parts smaller.
//  5. NEIGHBOURHOOD_BLOCK_BYTES: code around the change one symbol over
//     24 KB renders over the cap, or leaves symbols out without naming the
//     packet that holds them.
//  6. DELIVER_LINES: a range one row over 4,000 rows stays one part, or
//     loses a row when cut.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { buildFindBrief, hunkRows, readCoverage } from "@openqodex/core";
import type { Change, HunkRef, ImpactSummary, ReviewUnit } from "@openqodex/core";
import { makeLineSet } from "../../../tests/line-set.mjs";
import { makeChange } from "../../core/src/test-fixtures.js";
import { DELIVER_LINES } from "../src/conversation.js";
import { fragmentSnapshotText } from "../src/line-fragments.js";
import { buildNeighbourhood, NEIGHBOURHOOD_BLOCK_BYTES, NEIGHBOURHOOD_MAX_BYTES, NEIGHBOURHOOD_TIME_MS, renderNeighbourhoodBlock } from "../src/neighbourhood.js";
import type { Neighbourhood } from "../src/neighbourhood.js";
import { longestBrief, MAX_BRIEF_BYTES, MAX_UNIT_DIFF_BYTES, obligations, partBudget, unitsOf } from "../src/units.js";
import { cleanupFixtures, fixture } from "./staged-fixture.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(cleanupFixtures);
afterAll(removeTempDirs);

// The smallest n in [from, to] where `over(n)` holds; `over(from)` must not.
function firstOver(from: number, to: number, over: (n: number) => boolean): number {
  expect(over(from)).toBe(false);
  for (let n = from + 1; n <= to; n++) if (over(n)) return n;
  throw new Error(`the limit never bit between ${from} and ${to}`);
}

function snapshot(files: Record<string, string>): string {
  const dir = tempDir("oq-limits-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function changed(dir: string, path: string): Change {
  return makeChange({
    repoRoot: dir, files: [{ path, status: "modified", oldPath: null, binary: false }], changedPaths: [path],
    coverage: new Map([[path, makeLineSet([1])]]), deletionPoints: new Map(), diffs: [], diff: "",
  });
}

// An impact summary whose graph links every name to the change.
function linking(names: string[]): ImpactSummary {
  return {
    version: 2, status: "ok", reasons: [], risk: "low",
    build: { durationMs: 0, cacheHits: 0, parses: 1, eligibleFiles: 1, parsedFiles: 1, omittedFiles: 0, unresolvedSites: 0, externalSites: 0, mode: "fresh", generation: null },
    symbols: names.map((name, i) => ({ id: `seed${i}`, file: "changed.src", name, kind: "function", startLine: 1, endLine: 1, snapshot: "current" })),
    touched: names.map((_, i) => `seed${i}`), removed: [], callers: [], callees: [], importers: [], hubs: [], exports: [],
    unknown: { floor: false, seeds: [], causes: {}, near: [], nearTotal: 0, notRead: [], notReadTotal: 0 },
    cuts: [], truncated: { walk: false, inline: false, omittedSites: 0 }, packet: null,
  };
}

// `n` linked names on one changed line, each used in four files of five
// long lines, so each symbol carries about 5 KB of sites.
function linkedPacket(n: number): { packet: Neighbourhood; bytes: number } {
  const names = Array.from({ length: n }, (_, i) => `linkedName${String(i).padStart(2, "0")}`);
  const files: Record<string, string> = { "changed.src": `${names.join(" ")}\n` };
  for (const [i, name] of names.entries()) {
    for (let k = 0; k < 4; k++) files[`use/u${String(i).padStart(2, "0")}-${k}.src`] = Array.from({ length: 5 }, (_, j) => (j === 2 ? `return ${name}(${"x".repeat(200)});` : `const pad = ${"y".repeat(200)};`)).join("\n") + "\n";
  }
  const dir = snapshot(files);
  const packet = buildNeighbourhood({ snapshotDir: dir, change: changed(dir, "changed.src"), impact: linking(names), secrets: [] });
  return { packet, bytes: Buffer.byteLength(readFileSync(join(dir, packet.packetPath!))) };
}

it("1. NEIGHBOURHOOD_MAX_BYTES: one linked symbol over the packet cap is cut alone, and the packet says so", () => {
  const n = firstOver(1, 30, (k) => linkedPacket(k).packet.droppedLinked! > 0);
  const under = linkedPacket(n - 1);
  expect(under.packet).toMatchObject({ partial: null, cause: null, droppedLinked: 0, droppedOther: 0 });
  expect(under.bytes).toBeLessThanOrEqual(NEIGHBOURHOOD_MAX_BYTES);
  const over = linkedPacket(n);
  expect(over.packet).toMatchObject({ partial: "1 symbols cut at the packet byte cap.", cause: "bytes", droppedLinked: 1, droppedOther: 0 });
  expect(over.packet.symbols).toHaveLength(n - 1);
  expect(over.bytes).toBeLessThanOrEqual(NEIGHBOURHOOD_MAX_BYTES);
});

it("2. NEIGHBOURHOOD_TIME_MS: a scan that reaches the cap is partial with cause time; one a millisecond under is whole", () => {
  const dir = snapshot({ "a.src": "reprice\n", "b.src": "return reprice();\n" });
  const at = (ms: number) => {
    let first = true;
    return buildNeighbourhood({ snapshotDir: dir, change: changed(dir, "a.src"), impact: null, secrets: [], now: () => (first ? ((first = false), 0) : ms) });
  };
  const under = at(NEIGHBOURHOOD_TIME_MS - 1);
  expect(under).toMatchObject({ partial: null, cause: null });
  expect(under.symbols.map((s) => s.name)).toEqual(["reprice"]);
  const over = at(NEIGHBOURHOOD_TIME_MS);
  expect(over.partial).toMatch(/^Time cap reached after /);
  expect(over.cause).toBe("time");
});

// A new file of `n` rows, each `row(i)`, on a fixture change.
function newFile(n: number, row: (i: number) => string) {
  const f = fixture(["a.txt"]);
  const rows = Array.from({ length: n }, (_, i) => row(i + 1));
  writeFileSync(join(f.dir, "a.txt"), rows.join("\n") + "\n");
  f.change.coverage.set("a.txt", makeLineSet(rows.map((_, i) => i + 1)));
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1,${n} @@\n${rows.map((r) => `+${r}`).join("\n")}\n` }];
  return { f, refs: (partBytes?: number) => obligations(f.change, fragmentSnapshotText(f.dir), undefined, partBytes) };
}
const added = (change: Change, refs: HunkRef[]) => new Set(refs.flatMap((h) => hunkRows(change, h).filter((r) => r.startsWith("+"))));

it("3. MAX_UNIT_DIFF_BYTES: a range one row over 120 KB becomes two parts under the cap, every row carried", () => {
  const row = (i: number) => `${String(i).padStart(4, "0")}${"x".repeat(996)}`;
  const n = firstOver(100, 140, (k) => newFile(k, row).refs().length > 1);
  const under = newFile(n - 1, row).refs();
  expect(under).toHaveLength(1);
  expect(under[0]!.bytes!).toBeLessThanOrEqual(MAX_UNIT_DIFF_BYTES);
  expect(under[0]!.bytes! + 1024).toBeGreaterThan(MAX_UNIT_DIFF_BYTES);
  const { f, refs } = newFile(n, row);
  const parts = refs();
  expect(parts).toHaveLength(2);
  expect(parts.every((h) => h.bytes! <= MAX_UNIT_DIFF_BYTES)).toBe(true);
  expect(added(f.change, parts).size).toBe(n);
});

it("4. MAX_BRIEF_BYTES: fixed blocks that put a 120 KB part just over the bound cut parts smaller, and every range is carried", () => {
  const { f, refs } = newFile(400, (i) => `${String(i).padStart(4, "0")}${"z".repeat(996)}`);
  const finder = (instructions?: string) => (unit: ReviewUnit, pass: "local" | "contracts") => buildFindBrief({ ...f, secrets: [], lenses: [], instructions }, unit, pass);
  const empty: ReviewUnit = { id: "u1", files: [], hunks: [], diffBytes: 0 };
  const bare = Buffer.byteLength(longestBrief(empty, finder(), true));
  // Instructions that leave a full 120 KB part about 1 KB short of room.
  const find = finder("r".repeat(MAX_BRIEF_BYTES - MAX_UNIT_DIFF_BYTES - bare + 1024));
  const fixed = Buffer.byteLength(longestBrief(empty, find, true));
  const measure = (u: ReviewUnit, both?: boolean) => longestBrief(u, find, both);
  // Parts cut to the unit budget alone: a brief would pass the bound, so the
  // units leave its range unread with a note.
  const plain = refs();
  const plainUnits = unitsOf(f.change, plain, measure);
  const plainUnread = readCoverage({ change: f.change, obligations: plain, briefCarried: plainUnits.flatMap((u) => u.hunks), trace: [] }).unread;
  expect(plainUnread.length).toBeGreaterThan(0);
  // Parts cut to the room the fixed blocks leave.
  const cut = refs(partBudget(fixed));
  const units = unitsOf(f.change, cut, measure);
  for (const unit of units) for (const pass of ["local", "contracts"] as const) expect(Buffer.byteLength(find(unit, pass).text)).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
  expect(cut.some((h) => h.note)).toBe(false);
  expect(readCoverage({ change: f.change, obligations: cut, briefCarried: units.flatMap((u) => u.hunks), trace: [] }).unread).toEqual([]);
  expect(added(f.change, cut).size).toBe(400);
});

// `n` symbols of about 1 KB each, as the inline block renders them.
function blockPacket(n: number): Neighbourhood {
  return {
    symbols: Array.from({ length: n }, (_, i) => ({
      name: `symbol${String(i).padStart(2, "0")}`, changedIn: ["a.src"], files: 2,
      sites: [{ path: "use.src", line: 1, kind: "used" as const, from: "text" as const, context: `1\t${"q".repeat(1000)}` }],
    })),
    packetPath: ".openqodex-review/neighbourhood.md", partial: null, durationMs: 1,
  };
}

it("5. NEIGHBOURHOOD_BLOCK_BYTES: one symbol over 24 KB keeps the block under the cap and names the packet for the rest", () => {
  const n = firstOver(1, 40, (k) => renderNeighbourhoodBlock(blockPacket(k)).includes("for the remaining"));
  const under = renderNeighbourhoodBlock(blockPacket(n - 1));
  expect(Buffer.byteLength(under)).toBeLessThanOrEqual(NEIGHBOURHOOD_BLOCK_BYTES);
  expect((under.match(/^#### /gm) ?? []).length).toBe(n - 1);
  const over = renderNeighbourhoodBlock(blockPacket(n));
  expect(Buffer.byteLength(over)).toBeLessThanOrEqual(NEIGHBOURHOOD_BLOCK_BYTES);
  const shown = (over.match(/^#### /gm) ?? []).length;
  expect(over).toContain(`Read .openqodex-review/neighbourhood.md for the remaining ${n - shown} symbols.`);
  expect(shown).toBeGreaterThan(0);
});

it("6. DELIVER_LINES: a range one row over 4,000 rows becomes two parts under the cap, every row carried", () => {
  const row = (i: number) => `row ${i}`;
  const n = firstOver(DELIVER_LINES - 20, DELIVER_LINES + 20, (k) => newFile(k, row).refs().length > 1);
  expect(n).toBeLessThanOrEqual(DELIVER_LINES + 1);
  const under = newFile(n - 1, row).refs();
  expect(under).toHaveLength(1);
  expect(under[0]!.rows!).toBeLessThanOrEqual(DELIVER_LINES);
  const { f, refs } = newFile(n, row);
  const parts = refs();
  expect(parts).toHaveLength(2);
  expect(parts.every((h) => h.rows! <= DELIVER_LINES)).toBe(true);
  expect(added(f.change, parts).size).toBe(n);
});
