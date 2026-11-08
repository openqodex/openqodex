// Failure cases: invented quotes, wrong line windows, removed evidence
// checked against head text, missing examination, unknown verdict ids,
// unresolved scanners, and confirmed anchors outside the change.
// A refuted scanner's reason must pass prose checks before assembly.
import { afterAll, expect, it } from "vitest";
import { checkEvidence, checkFindAnswer, checkVerifyAnswer } from "../src/evidence-check.js";
import { hunkRefs, unitsOf } from "../src/units.js";
import { snapshotText, lineCounter } from "../src/snapshot.js";
import { cleanupFixtures, candidate, fixture, scanner, verdict } from "./staged-fixture.js";

afterAll(cleanupFixtures);
it("rejects invented quotes and quotes farther than two lines away", () => {
  const { change } = fixture();
  const cite = { file_path: "a.txt", line_number: 4, quote: "unsafe   operation" };
  expect(checkEvidence(cite, () => "unsafe operation\n\n\n\n", change)).toContain("a.txt:4");
  expect(checkEvidence({ ...cite, line_number: 3 }, () => "unsafe operation\n\n\n\n", change)).toBeNull();
  expect(checkEvidence({ ...cite, quote: "invented" }, () => "unsafe operation", change)).not.toBeNull();
});
it("checks deletion evidence in removed lines even when its file is gone", () => {
  const { change } = fixture();
  const cite = { file_path: "a.txt", line_number: 1, quote: "old   operation", removed: true as const };
  expect(checkEvidence(cite, () => null, change)).toBeNull();
  expect(checkEvidence({ ...cite, quote: "unsafe operation" }, () => null, change)).not.toBeNull();
});
it("keeps a deleted-file candidate and its confirmed verdict with removed evidence at anchor 1", () => {
  const { change } = fixture(["a.txt"]);
  change.files[0]!.status = "deleted";
  change.coverage.clear();
  change.deletionPoints.set("a.txt", [{ after: 0, lines: 1, anchors: [1] }]);
  change.diffs = [{ path: "a.txt", text: "@@ -1 +0,0 @@\n-old operation\n" }];
  const unit = unitsOf(change, hunkRefs(change))[0]!;
  const c = { ...candidate("a.txt"), evidence: [{ file_path: "a.txt", line_number: 1, quote: "old operation", removed: true as const }] };
  const found = checkFindAnswer({ version: "find-1", change_id: change.id, unit: unit.id, examined: ["h1"], analysis: [{ hunk: "h1", changed: "The module was deleted.", could_break: "Callers still import it." }], candidates: [c] }, unit, change, () => null);
  expect(found.errors).toEqual([]);
  expect(found.rejected).toEqual([]);
  const item = { id: "k1", kind: "finder" as const, candidate: c, foundBy: [] };
  const checked = checkVerifyAnswer({ version: "verify-1", change_id: change.id, verdicts: [verdict(item)] }, { file: "a.txt", hunks: unit.hunks, candidates: [item] }, change, () => null, () => null);
  expect(checked.errors).toEqual([]);
});
it.each(["unsafe operation", "unsafe operation\n"])("rejects a quote at line 3 past a one-line file's end: %j", (text) => {
  const { change } = fixture();
  expect(checkEvidence({ file_path: "a.txt", line_number: 3, quote: "unsafe operation" }, () => text, change)).not.toBeNull();
});
it("strips unknown keys and names a missing examination and analysis", () => {
  const { change, dir } = fixture();
  const unit = unitsOf(change, hunkRefs(change))[0]!;
  const out = checkFindAnswer({ version: "find-1", change_id: change.id, unit: unit.id, examined: [], analysis: [], candidates: [], extra: true }, unit, change, snapshotText(dir));
  expect(out.errors.join(" ")).toContain("h1");
  expect(out.answer).not.toHaveProperty("extra");
});
it("rejects a finder below the confidence floor or without evidence", () => {
  const { change, dir } = fixture();
  const unit = unitsOf(change, hunkRefs(change))[0]!;
  const out = checkFindAnswer({ version: "find-1", change_id: change.id, unit: unit.id, examined: ["h1"], analysis: [{ hunk: "h1", changed: "Operation changed", could_break: "Inputs" }], candidates: [{ ...candidate("a.txt"), confidence: 0.49, evidence: [] }] }, unit, change, snapshotText(dir));
  expect(out.errors.join(" ")).toMatch(/confidence/);
  expect(out.errors.join(" ")).toMatch(/evidence/);
});
it("rejects unresolved scanners, duplicate verdicts, unknown ids and wrong anchors", () => {
  const { change, dir } = fixture();
  const c = { kind: "scanner" as const, id: "c1", candidate: scanner("a.txt") };
  const batch = { file: "a.txt", hunks: hunkRefs(change), candidates: [c] };
  const value = { version: "verify-1", change_id: change.id, verdicts: [verdict(c, "unresolved"), { ...verdict(c), id: "k99", line_number: 2 }, verdict(c)] };
  const errors = checkVerifyAnswer(value, batch, change, snapshotText(dir), lineCounter(dir)).errors.join(" ");
  expect(errors).toContain("a scanner candidate is confirmed or refuted");
  expect(errors).toContain("exactly one");
  expect(errors).toContain("not in this batch");
  expect(errors).toContain("not a line this change");
});
it("rejects missing ids and duplicate cycles", () => {
  const { change, dir } = fixture();
  const c = { kind: "scanner" as const, id: "c1", candidate: scanner("a.txt") };
  const batch = { file: "a.txt", hunks: hunkRefs(change), candidates: [c, { ...c, id: "c2" }] };
  const value = { version: "verify-1", change_id: change.id, verdicts: [{ ...verdict(c), duplicate_of: "c2" }, { ...verdict(c), id: "c2", duplicate_of: "c1" }] };
  expect(checkVerifyAnswer(value, batch, change, snapshotText(dir), lineCounter(dir)).errors.join(" ")).toContain("cycle");
  value.verdicts.pop();
  expect(checkVerifyAnswer(value, batch, change, snapshotText(dir), lineCounter(dir)).errors.join(" ")).toContain("candidate c2");
});

// Failure cases: quotes span lines, and a duplicate hides a scanner.
it("matches a multiline quote in the joined cited window", () => {
  const { change } = fixture();
  expect(checkEvidence({ file_path: "a.txt", line_number: 2, quote: "first\n  second" }, () => "before\nfirst\nsecond\nafter", change)).toBeNull();
});
it("rejects a scanner marked as a duplicate of a finder", () => {
  const { change, dir } = fixture();
  const c = { kind: "scanner" as const, id: "c1", candidate: scanner("a.txt") };
  const k = { kind: "finder" as const, id: "k1", candidate: candidate("a.txt"), foundBy: [] };
  const batch = { file: "a.txt", hunks: hunkRefs(change), candidates: [c, k] };
  const value = { version: "verify-1", change_id: change.id, verdicts: [{ ...verdict(c), duplicate_of: "k1" }, verdict(k)] };
  expect(checkVerifyAnswer(value, batch, change, snapshotText(dir), lineCounter(dir)).errors).toContain("candidate c1.duplicate_of: a scanner candidate survives; mark the finder candidate as the duplicate");
});

it("rejects a refuted scanner reason with three sentences during verification", () => {
  const { change, dir } = fixture();
  const c = { kind: "scanner" as const, id: "c1", candidate: scanner("a.txt") };
  const batch = { file: "a.txt", hunks: hunkRefs(change), candidates: [c] };
  const value = { version: "verify-1", change_id: change.id, verdicts: [{ ...verdict(c, "refuted"), reason: "The input is checked. The operation is safe. The caller is trusted." }] };
  expect(checkVerifyAnswer(value, batch, change, snapshotText(dir), lineCounter(dir)).errors).toContain("candidate c1.reason: has 3 sentences; the limit is 2");
});

// Failure cases: finder prose bypasses checks, or verifier fields share one limit.
it.each([
  ["four sentences", "One. Two. Three. Four.", "has 4 sentences; the limit is 3"],
  ["em dash", `Unsafe ${String.fromCharCode(0x2014)} input.`, "em dash"],
  ["line break", "Unsafe\ninput.", "control character"],
  ["long sentence", Array(21).fill("word").join(" "), "has 21 words"],
])("returns a finder claim with %s as a broken rule", (_name, claim, error) => {
  const { change, dir } = fixture();
  const unit = unitsOf(change, hunkRefs(change))[0]!;
  const out = checkFindAnswer({ version: "find-1", change_id: change.id, unit: unit.id, examined: ["h1"], analysis: [{ hunk: "h1", changed: "Changed.", could_break: "Output." }], candidates: [{ ...candidate("a.txt"), claim }] }, unit, change, snapshotText(dir));
  expect(out.errors.join(" ")).toContain(`candidates[0].claim`);
  expect(out.rejected[0]?.errors.join(" ")).toContain(error);
});
it("accepts three verifier problem sentences but rejects four and three consequence sentences", () => {
  const { change, dir } = fixture();
  const c = { kind: "finder" as const, id: "k1", candidate: candidate("a.txt"), foundBy: [] };
  const batch = { file: "a.txt", hunks: hunkRefs(change), candidates: [c] };
  const three = "close shuts down the pool. put raises ShutDown. submit catches it and commits.";
  const check = (fields: object) => checkVerifyAnswer({ version: "verify-1", change_id: change.id, verdicts: [{ ...verdict(c), ...fields }] }, batch, change, snapshotText(dir), lineCounter(dir)).errors;
  expect(check({ problem: three })).toEqual([]);
  expect(check({ problem: `${three} Results disappear.` }).join(" ")).toContain("has 4 sentences; the limit is 3");
  expect(check({ consequence: three }).join(" ")).toContain("has 3 sentences; the limit is 2");
});
