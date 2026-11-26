// scripts/note-rates.mjs, on a tiny made-up sweep: every name, number and
// reason here is invented.
//
// Ways it could fail, written before the code:
//  1. A reason that holds spaces or "=" is cut at the first space, or eats
//     the keys after it.
//  2. A step from before reasonCode existed gets no code, or a code the
//     library would not give that reason; a step that carries reasonCode is
//     read from its reason instead.
//  3. A step is put in the wrong week at a year's end, or a review's other
//     steps are counted.
//  4. A share above 20% is not flagged, or the complete status is.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { format, isoWeek, parseExcerpt, rates, stepsOf } from "../../../scripts/note-rates.mjs";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const NOV_26 = Date.UTC(2026, 10, 26, 12);
const JAN_1 = Date.UTC(2027, 0, 1, 12);
const counts = "scope=delta findings=0 dispositions=0 calls=2 failed=0 refused=0 tools_served=0 rounds=1 files_opened=1 files_not_opened=0 cost=0.01 clone_ms=900 review_ms=4000";
const step = (createdAt: number, excerpt: string, name = "library_review") => ({ name, kind: "phase", createdAt, resultExcerpt: excerpt });
const review = (...steps: ReturnType<typeof step>[]) => JSON.stringify({ review: { id: "r" }, steps });

const sweep = [
  review(step(NOV_26, "posted", "post_comment"), step(NOV_26, `status=complete ${counts}`)),
  review(step(NOV_26, `status=complete ${counts}`)),
  review(step(NOV_26, `status=complete ${counts}`)),
  review(step(NOV_26, `status=incomplete ${counts} reason=1 changed range was not examined; src/a.ts:1-9 (part 1 of 2)`)),
  review(step(NOV_26, `status=incomplete ${counts} reason=unit u2 was not started: its finder brief exceeds MAX_BRIEF_BYTES; a=b stays in the reason source=sweep`)),
  review(step(JAN_1, `status=nothing_to_review ${counts} reasonCode=nothing_to_review reason=nothing to review: the head adds no change since the previously reviewed commit`)),
  review(step(JAN_1, `status=incomplete ${counts} reason_code=deadline_timeout partial_cause=bytes reason=the reviewer timed out and was stopped`)),
].join("\n") + "\n";

it("1. reads a reason with spaces and '=' whole, and the keys after it", () => {
  expect(parseExcerpt(`status=incomplete ${counts} reason=x=y and more source=sweep`)).toMatchObject({ status: "incomplete", review_ms: "4000", reason: "x=y and more", source: "sweep" });
});

it("2. gives an old step the library's code for its reason, and keeps a code a step carries", () => {
  const records = stepsOf(sweep);
  expect(records.map((r) => r.code)).toEqual([null, null, null, "range_not_examined", "brief_too_big", "nothing_to_review", "deadline_timeout"]);
  expect(records[3]!.notes).toEqual(["range_not_examined"]);
  expect(records[4]!.notes).toEqual(["brief_too_big", "unit_not_examined"]);
  expect(records[6]).toMatchObject({ partial: "bytes", notes: ["timed_out"] });
  // Before the nothing_to_review status, such a review ended complete.
  expect(stepsOf(review(step(NOV_26, `status=complete ${counts} reason=nothing to review: the head adds no change since the previously reviewed commit`)))[0]).toMatchObject({ status: "complete", code: "nothing_to_review" });
});

it("3. counts library_review steps only, each in its ISO week, across a year's end", () => {
  expect(isoWeek(NOV_26)).toBe("2026-W48");
  expect(isoWeek(JAN_1)).toBe("2026-W53");
  expect(isoWeek(new Date(NOV_26).toISOString())).toBe("2026-W48");
  const weeks = rates(stepsOf(sweep));
  expect([...weeks.keys()]).toEqual(["2026-W48", "2026-W53"]);
  expect(weeks.get("2026-W48")).toMatchObject({ total: 5, status: { complete: 3, incomplete: 2 } });
  expect(weeks.get("2026-W53")).toMatchObject({ total: 2, status: { nothing_to_review: 1, incomplete: 1 }, partial: { bytes: 1 } });
});

it("4. flags each share above 20%, never the complete status, from the command line", () => {
  const dir = tempDir("oq-note-rates-");
  writeFileSync(join(dir, "sweep.jsonl"), sweep);
  const out = execFileSync(process.execPath, [join(root, "scripts/note-rates.mjs"), join(dir, "sweep.jsonl")], { encoding: "utf8" });
  expect(out).toBe(format(rates(stepsOf(sweep))) + "\n");
  const lines = out.split("\n");
  expect(lines).toContain("2026-W48: 5 library reviews");
  expect(lines).toContain("  status complete: 3 (60.0%)");
  expect(lines).toContain("  status incomplete: 2 (40.0%)  FLAG: above 20%");
  // One in five is 20%, not above it.
  expect(lines).toContain("  reason code brief_too_big: 1 (20.0%)");
  expect(lines).toContain("  partial cause bytes: 1 (50.0%)  FLAG: above 20%");
});
