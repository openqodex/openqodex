// Incremental review: with a previously reviewed commit that the clone proves
// is an ancestor of the head, the review's obligation (the brief, the scan,
// the coverage) is what changed since then, inside the change; findings are
// still anchored and checked on the whole change. Every other case is an
// explicit full review with its reason, and a merge base that cannot be
// proved ends the review as incomplete.
//
// Ways it could fail, written before the code:
//  1. With the previous commit an ancestor, the obligation holds lines that
//     were reviewed before or misses one changed since, its brief diff
//     carries a hunk reviewed before, its id differs from the change's (the
//     brief and the check then disagree), or the whole change is narrowed
//     too; the previous commit equal to the head leaves an obligation; the
//     merge base is not recorded as the host's.
//  2. Lines a merge of the base branch brought in after the previous review
//     become part of the obligation.
//  3. A full review the host asked for, or one with no previous commit, is
//     narrowed or gives no reason.
//  4. A rewritten branch (the previous commit is not an ancestor) narrows
//     the review, or is reported as unknown history.
//  5. A shallow clone that cannot show the ancestry is reported as
//     diverged, or narrows the review.
//  6. A previous commit the clone does not hold, or an id that is not a
//     commit, narrows the review or throws.
//  7. A replacement ref in the clone (refs/replace) forges a proof: a head
//     that does not descend from the merge base passes, because the ref
//     points it at a commit that does.
//  8. A file previous..head changed but could not cover (a large merge of
//     the base branch used the coverage limit up) is dropped from the
//     obligation, so its changed lines go unreviewed or the review says
//     there is nothing to review.
// The merge base proofs themselves are tested once, through reviewChange
// (merge-base.test.ts).
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decideIncremental, reviewChanges } from "../src/incremental.js";
import { admitted } from "../src/scopes.js";
import { commit, git, history, lines, write } from "./scope-fixture.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const all = admitted(undefined, []);

async function changes(dir: string, mergeBaseSha: string, headSha: string, previousReviewedSha?: string, fullReviewRequested?: boolean) {
  const decision = await decideIncremental({ clonePath: dir, mergeBaseSha, headSha, previousReviewedSha, fullReviewRequested });
  if (!decision.ok) throw new Error(decision.reason);
  const got = await reviewChanges({ clonePath: dir, baseRef: "main", mergeBaseSha, headSha, admit: all, exclude: [], decision });
  return { decision, ...got };
}

const sorted = (s: Set<number> | undefined) => [...(s ?? [])].sort((a, b) => a - b);

describe("the obligation of an incremental review", () => {
  it("1. with the previous commit an ancestor, only what changed since, inside the whole change", async () => {
    const h = history();
    const r = await changes(h.dir, h.base, h.head, h.previous);
    expect(r.decision.scope).toEqual({ kind: "delta", reason: `delta: only what changed since the previously reviewed commit ${h.previous.slice(0, 12)} is reviewed; findings are anchored on the whole change` });
    expect(r.obligation.files.map((f) => f.path).sort()).toEqual(["s/a.ts", "s/b.ts"]);
    expect(sorted(r.obligation.coverage.get("s/a.ts"))).toEqual([25]);
    expect(sorted(r.obligation.coverage.get("s/b.ts"))).toEqual([3]);
    expect(r.obligation.coverage.has("s/c.ts")).toBe(false);
    // The whole change is untouched: findings anchor on it.
    expect(r.full.files.map((f) => f.path).sort()).toEqual(["s/a.ts", "s/b.ts", "s/c.ts"]);
    expect(sorted(r.full.coverage.get("s/a.ts"))).toEqual([5, 25]);
    expect(r.obligation.id).toBe(r.full.id);
    expect(r.obligation.shortId).toBe(r.full.shortId);
    expect(r.obligation.baseSha).toBe(h.base);
    // The brief's diff: the hunk changed since, not the one reviewed before.
    expect(r.obligation.diff).toContain("+changed since the previous review");
    expect(r.obligation.diff).not.toContain("+changed before the previous review");
    expect(r.obligation.diff).toContain("+changed since too");
    expect(r.obligation.diffs?.map((d) => d.path).sort()).toEqual(["s/a.ts", "s/b.ts"]);
    expect(r.obligation.stats).toEqual({ files: 2, additions: 2, deletions: 2 });
    expect(r.decision).toMatchObject({ mergeBase: { sha: h.base, suppliedBy: "host" } });
    // Nothing changed since: nothing to review.
    const same = await changes(h.dir, h.base, h.head, h.head);
    expect(same.obligation.files).toEqual([]);
    expect(same.full.files.length).toBe(3);
  });

  it("2. lines a merge of the base branch brought in after the previous review are not part of it", async () => {
    const h = history();
    git(h.dir, "checkout", "-q", "main");
    write(h.dir, "s/a.ts", lines(40, { 38: "changed on main" }));
    write(h.dir, "s/m.ts", "export const fromMain = 1;\n");
    const mainTip = commit(h.dir, "M");
    git(h.dir, "checkout", "-q", "feature");
    git(h.dir, "merge", "-q", "--no-edit", "main");
    write(h.dir, "s/a.ts", lines(40, { 5: "changed before the previous review", 25: "changed since the previous review", 38: "changed on main", 15: "changed after the merge" }));
    const head = commit(h.dir, "P3");
    // The host's comparison base moved to main's tip with the merge.
    const r = await changes(h.dir, mainTip, head, h.previous);
    expect(r.decision.scope.kind).toBe("delta");
    expect(r.obligation.files.map((f) => f.path).sort()).toEqual(["s/a.ts", "s/b.ts"]);
    expect(sorted(r.obligation.coverage.get("s/a.ts"))).toEqual([15, 25]);
    expect(r.obligation.diff).not.toContain("fromMain");
    expect(r.obligation.diff).not.toContain("+changed on main");
  });
});

describe("a delta that could not be covered", () => {
  it("8. a file the delta could not cover keeps its whole-change lines as the obligation", async () => {
    const h = history();
    // The base branch gains a file of exactly the coverage limit, which a
    // merge brings into the feature branch after the previous review.
    git(h.dir, "checkout", "-q", "main");
    write(h.dir, "a/big.txt", "x\n".repeat(500_000));
    const mainTip = commit(h.dir, "M");
    git(h.dir, "checkout", "-q", "feature");
    git(h.dir, "merge", "-q", "--no-edit", "main");
    write(h.dir, "s/b.ts", lines(10, { 3: "changed since too", 7: "changed after the merge" }));
    const head = commit(h.dir, "P3");
    const r = await changes(h.dir, mainTip, head, h.previous);
    expect(r.decision.scope.kind).toBe("delta");
    expect(r.obligation.files.map((f) => f.path).sort()).toEqual(["s/a.ts", "s/b.ts"]);
    expect(sorted(r.obligation.coverage.get("s/a.ts"))).toEqual([5, 25]);
    expect(sorted(r.obligation.coverage.get("s/b.ts"))).toEqual([3, 7]);
  }, 120_000);
});

describe("an explicit full review, with its reason", () => {
  it("3. the host asked for one, or there is no previous review", async () => {
    const h = history();
    const asked = await changes(h.dir, h.base, h.head, h.previous, true);
    expect(asked.decision.scope).toEqual({ kind: "full", reason: "requested: the host asked for a full review" });
    expect(asked.obligation).toBe(asked.full);
    const none = await changes(h.dir, h.base, h.head);
    expect(none.decision.scope).toEqual({ kind: "full", reason: "no previous review: the whole change is reviewed" });
    expect(none.obligation).toBe(none.full);
  });

  it("4. the branch was rewritten: diverged", async () => {
    const h = history();
    git(h.dir, "reset", "-q", "--hard", h.base);
    write(h.dir, "s/a.ts", lines(40, { 7: "rewritten" }));
    const head = commit(h.dir, "rewritten");
    const r = await changes(h.dir, h.base, head, h.previous);
    expect(r.decision.scope.kind).toBe("full");
    expect(r.decision.scope.reason).toMatch(/^diverged: the previously reviewed commit [0-9a-f]{12} is not an ancestor of the head [0-9a-f]{12}/);
  });

  it("5. a shallow clone that cannot show the ancestry: history unknown, not diverged", async () => {
    const h = history();
    git(h.dir, "config", "uploadpack.allowAnySHA1InWant", "true");
    const clone = join(tempDir("oq-inc-shallow-"), "clone");
    git(h.dir, "clone", "-q", "--depth", "1", "--branch", "feature", `file://${h.dir}`, clone);
    git(clone, "fetch", "-q", "--depth", "1", "origin", h.previous, h.base);
    const r = await changes(clone, h.base, h.head, h.previous).catch((e: Error) => ({ error: e.message }));
    // The merge base is not provable either: the review is incomplete.
    expect(r).toEqual({ error: expect.stringMatching(/^history unknown: the clone's history is cut \(a shallow clone\), so it cannot show that the merge base [0-9a-f]{12} is an ancestor of the head/) });
    const d = await decideIncremental({ clonePath: clone, mergeBaseSha: h.head, headSha: h.head, previousReviewedSha: h.previous });
    expect(d.ok && d.scope.kind).toBe("full");
    expect(d.ok && d.scope.reason).toMatch(/^history unknown: the clone's history is cut \(a shallow clone\), so it cannot show that the previously reviewed commit [0-9a-f]{12} is an ancestor of the head [0-9a-f]{12}; fetch the history between them/);
  });

  it("6. a previous commit the clone does not hold is unknown history naming the fetch; an id that is not a commit says so", async () => {
    const h = history();
    const missing = "1".repeat(40);
    const r = await changes(h.dir, h.base, h.head, missing);
    expect(r.decision.scope).toEqual({ kind: "full", reason: `history unknown: the previously reviewed commit ${missing.slice(0, 12)} is not in the clone (a force push removes it from the branch); fetch it (git fetch origin ${missing}) to review only what changed since; the whole change is reviewed` });
    const tree = git(h.dir, "rev-parse", `${h.previous}^{tree}`);
    for (const id of [tree, "abc123", "not an id"]) {
      const n = await changes(h.dir, h.base, h.head, id);
      expect(n.decision.scope.kind, id).toBe("full");
      expect(n.decision.scope.reason, id).toMatch(/^not a commit: the previously reviewed commit .* the whole change is reviewed$/);
    }
  });
});

describe("the proofs and replacement refs", () => {
  it("7. a replacement ref cannot forge the ancestry: a head outside the merge base's history stays diverged", async () => {
    const h = history();
    // A head with no history in common with the base.
    git(h.dir, "checkout", "-q", "--orphan", "unrelated");
    write(h.dir, "s/a.ts", lines(40, { 1: "unrelated" }));
    const unrelated = commit(h.dir, "unrelated");
    // A commit that does descend from the base, and a ref that puts it in
    // the unrelated head's place.
    git(h.dir, "checkout", "-q", "-f", "main");
    write(h.dir, "s/a.ts", lines(40, { 2: "descends" }));
    const descends = commit(h.dir, "descends");
    git(h.dir, "replace", unrelated, descends);
    const d = await decideIncremental({ clonePath: h.dir, mergeBaseSha: h.base, headSha: unrelated });
    expect(d.ok ? "the proof passed" : d.reason).toMatch(/^diverged: /);
  });
});
