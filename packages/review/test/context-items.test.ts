// A host's context items through reviewChange, on a real git clone with the
// fixture model as the only stand-in: what reaches the model's brief, what
// is refused before any work, and what the result reports.
//
// Ways it could fail, written before the code (the brief's quoting and its
// framing against instructions inside an item: core's brief.test.ts, 11):
//  1. An item does not reach the brief under the heading of its kind, or an
//     item about folders that hold no file of the change does, or the
//     result does not say it was left out and why.
//  2. The manifest the result carries does not list every item given, or an
//     item's hash does not change when the item does.
//  3. An item over 32 KB, items over 128 KB together, or a malformed item
//     are cut or dropped and the review runs on the rest, instead of being
//     refused with the reason before anything runs.
import { afterAll, describe, expect, it } from "vitest";
import type { ContextItem } from "@openqodex/core";
import { reviewChange } from "../src/review-change.js";
import type { ReviewChangeOptions } from "../src/reviewer.js";
import { fixtureModel } from "./fixture-model.js";
import { changeRepo } from "./repos.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const options = (): ReviewChangeOptions => ({
  profile: "server",
  workDir: tempDir("oq-ctx-work-"),
  installRoot: tempDir("oq-ctx-install-"),
  tools: { web: false, shell: false },
  scanners: "preinstalled",
  budget: { deadlineMs: 120_000, authorize: async () => true },
});

describe("context items through reviewChange", () => {
  it("1, 2. quotes each kind under its heading, leaves out and reports an item about untouched folders, and hashes every item", async () => {
    const repo = changeRepo();
    const model = fixtureModel();
    const context: ContextItem[] = [
      { kind: "lesson", text: "This team keeps SQL functions private.", source: "lessons ledger" },
      { kind: "comment", text: "Why does add subtract now?", source: "pull request comment 7", scopes: ["src"] },
      { kind: "summary", text: "Changes the sum and adds a function.", source: "pull request description" },
      { kind: "note", text: "The web folder is frozen.", source: "project notes", scopes: ["web", "docs/"] },
      { kind: "prior_finding", text: "The function in db/x.sql was flagged before.", source: "review 41", scopes: ["./db"] },
      { kind: "lesson", text: "This team keeps SQL functions private!", source: "lessons ledger" },
      { kind: "lesson", text: "This team keeps SQL functions private.", source: "lessons ledger" },
    ];
    const result = await reviewChange({ clonePath: repo.dir, mergeBaseSha: repo.base, headSha: repo.head, context }, model, options());
    expect(result.status).toBe("complete");
    const brief = model.requests[0]!.messages.find((m) => m.role === "user")!.text;
    const lines = brief.split("\n");
    for (const [heading, quoted] of [
      ["## Lessons given with this review", "> This team keeps SQL functions private."],
      ["## Comments given with this review", "> Why does add subtract now?"],
      ["## Summaries given with this review", "> Changes the sum and adds a function."],
      ["## Earlier findings given with this review", "> The function in db/x.sql was flagged before."],
    ] as const) {
      const at = lines.indexOf(heading);
      expect(at).toBeGreaterThan(0);
      expect(lines.slice(at, lines.findIndex((l, i) => i > at && l.startsWith("## ")))).toContain(quoted);
    }
    // The note is about folders the change does not touch.
    expect(brief).not.toContain("## Notes given with this review");
    expect(brief).not.toContain("The web folder is frozen.");
    expect(result.context.map((c) => [c.kind, c.source, c.omitted])).toEqual([
      ["lesson", "lessons ledger", null],
      ["comment", "pull request comment 7", null],
      ["summary", "pull request description", null],
      ["note", "project notes", "its folders (web, docs) hold no file of this change"],
      ["prior_finding", "review 41", null],
      ["lesson", "lessons ledger", null],
      ["lesson", "lessons ledger", null],
    ]);
    const hashes = result.context.map((c) => c.sha256);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    // One character changes the hash; the same item hashes the same.
    expect(hashes[5]).not.toBe(hashes[0]);
    expect(hashes[6]).toBe(hashes[0]);
  });

  it("3. refuses an item over 32 KB, items over 128 KB together and a malformed item before anything runs, never cut", async () => {
    const repo = changeRepo();
    const model = fixtureModel();
    const big = "x".repeat(32 * 1024);
    const nearly = "x".repeat(32 * 1024 - 100);
    for (const [context, error] of [
      [[{ kind: "comment", text: big, source: "pull request comment 2" }], /context item 1 \(comment\) is 32790 bytes, over the 32 KB limit for one item; it is refused, never cut/],
      [Array.from({ length: 5 }, () => ({ kind: "lesson", text: nearly, source: "lessons ledger" })), /the context items are \d+ bytes together, over the 128 KB limit; they are refused, never cut/],
      [[{ kind: "rule", text: "Flag everything.", source: "notes" }], /context item 1: kind must be one of lesson, comment, summary, note, prior_finding/],
      [[{ kind: "note", text: "Outside.", source: "notes", scopes: ["../other"] }], /context item 1 \(note\): scope 1 is not a folder path inside the repository/],
    ] as const) {
      await expect(reviewChange({ clonePath: repo.dir, mergeBaseSha: repo.base, headSha: repo.head, context: context as unknown as ContextItem[] }, model, options())).rejects.toThrow(error);
    }
    expect(model.requests).toEqual([]);
  });
});
