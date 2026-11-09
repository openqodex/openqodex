// 1. A second admitted-tree failure leaks the first change's patches.
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { reviewChanges } from "../src/incremental.js";
import { git } from "./repos.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";
afterAll(removeTempDirs);
it("1. releases the full change if the second admitted-tree build throws", async () => {
  const dir = tempDir("oq-delta-failure-");
  const root = tempDir("oq-delta-patches-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "small.txt"), "before\n");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "Base");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "large.txt"), "line contents\n".repeat(480_000));
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "Head");
  const head = git(dir, "rev-parse", "HEAD");
  await expect(reviewChanges({ clonePath: dir, baseRef: "main", mergeBaseSha: base, headSha: head, exclude: [], tempRoot: root, admit: () => {
    if (readdirSync(root).some((p) => /^[a-f0-9]{64}$/.test(p))) throw new Error("second tree refused");
    return true;
  }, decision: { ok: true, scope: { kind: "delta", reason: "test" }, previousReviewedSha: base, mergeBase: { sha: base, suppliedBy: "host" } } })).rejects.toThrow("second tree refused");
  expect(readdirSync(root)).toEqual([]);
});
