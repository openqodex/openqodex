// The proofs reviewChange makes in the host's clone before anything is
// scanned or sent: both commits are in the clone and are commits, and the
// merge base the host gave is an ancestor of the head. Each proof that
// fails ends the review as incomplete, naming the proof and the fetch the
// host must add, and no model call is made.
//
// Ways it could fail, written before the code:
//  1. The target branch's tip, given in place of the merge base, is taken as
//     the base: the change would hold the target's own later commits.
//  2. A shallow clone, where ancestry cannot be shown, is reported as
//     diverged (or passes), so the host adds the wrong fetch.
//  3. A merge base that is not an ancestor of the head passes.
//  4. A commit the clone does not hold throws, or passes as some other
//     reason.
//  5. A git failure (no repository) is reported as a missing commit or as
//     diverged.
//  6. A tree or a blob id given as a commit passes.
//  7. A partial clone that lacks the change's files throws, fetches them,
//     or is reported as anything but missing objects.
import { afterAll, describe, expect, it } from "vitest";
import { reviewChange } from "../src/review-change.js";
import type { ReviewChangeOptions } from "../src/reviewer.js";
import { fixtureModel } from "./fixture-model.js";
import { changeRepo, git } from "./repos.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

afterAll(removeTempDirs);

function options(): ReviewChangeOptions {
  const workDir = tempDir("oq-mb-work-");
  return { profile: "server", workDir, installRoot: workDir, budget: { deadlineMs: 120_000, authorize: async () => true }, tools: { web: false, shell: false }, scanners: "preinstalled" };
}

async function prove(clonePath: string, mergeBaseSha: string, headSha: string) {
  const model = fixtureModel();
  const result = await reviewChange({ clonePath, mergeBaseSha, headSha }, model, options());
  expect(model.requests).toEqual([]);
  expect(result.status).toBe("incomplete");
  expect(result.findings).toEqual([]);
  expect(result.usage.calls).toEqual([]);
  return result.reason ?? "";
}

describe("the merge base proofs", () => {
  it("1. the target branch's tip in place of the merge base fails the ancestor proof and says what to pass", async () => {
    const repo = changeRepo();
    // The target branch moves on after the feature branched off.
    git(repo.dir, "checkout", "-q", "main");
    writeFileSync(join(repo.dir, "later.txt"), "a later commit on the target\n");
    git(repo.dir, "add", "-A");
    git(repo.dir, "commit", "-qm", "Later");
    const tip = git(repo.dir, "rev-parse", "HEAD");
    git(repo.dir, "checkout", "-q", "feature");
    const reason = await prove(repo.dir, tip, repo.head);
    expect(reason).toMatch(/^diverged: the merge base [0-9a-f]{12} is not an ancestor of the head [0-9a-f]{12}/);
    expect(reason).toMatch(/pass the merge base of the pull request, not the target branch's tip/);
  });

  it("2. a shallow clone reports history unknown, not diverged, and names the fetch", async () => {
    const repo = changeRepo();
    git(repo.dir, "tag", "base-commit", repo.base);
    const shallow = tempDir("oq-mb-shallow-");
    git(shallow, "clone", "-q", "--depth", "1", "--branch", "feature", `file://${repo.dir}`, "c");
    const clone = join(shallow, "c");
    git(clone, "fetch", "-q", "--depth", "1", "origin", "tag", "base-commit");
    const reason = await prove(clone, repo.base, repo.head);
    expect(reason).toMatch(/^history unknown: /);
    expect(reason).toMatch(/fetch/);
  });

  it("3. a merge base outside the head's history is diverged", async () => {
    const repo = changeRepo();
    git(repo.dir, "checkout", "-q", "--orphan", "other");
    writeFileSync(join(repo.dir, "other.txt"), "unrelated\n");
    git(repo.dir, "add", "other.txt");
    git(repo.dir, "commit", "-qm", "Unrelated");
    const unrelated = git(repo.dir, "rev-parse", "HEAD");
    git(repo.dir, "checkout", "-q", "-f", "feature");
    expect(await prove(repo.dir, unrelated, repo.head)).toMatch(/^diverged: /);
  });

  it("4. a commit the clone does not hold is missing, named, with the fetch", async () => {
    const repo = changeRepo();
    const absent = "0123456789abcdef0123456789abcdef01234567";
    const base = await prove(repo.dir, absent, repo.head);
    expect(base).toMatch(/^missing commit: the merge base 0123456789ab is not in the clone/);
    expect(base).toMatch(/fetch/);
    expect(await prove(repo.dir, repo.base, absent)).toMatch(/^missing commit: the head 0123456789ab is not in the clone/);
  });

  it("5. a git failure is its own reason", async () => {
    const notRepo = tempDir("oq-mb-plain-");
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(await prove(notRepo, sha, sha)).toMatch(/^git failed: /);
  });

  it("6. a tree or a blob id is not a commit, and a short id is not a full commit id", async () => {
    const repo = changeRepo();
    const tree = git(repo.dir, "rev-parse", `${repo.head}^{tree}`);
    expect(await prove(repo.dir, tree, repo.head)).toMatch(/^not a commit: the merge base [0-9a-f]{12} is a tree/);
    expect(await prove(repo.dir, repo.base.slice(0, 12), repo.head)).toMatch(/^not a commit: the merge base .* is not a full commit id/);
  });

  it("7. a partial clone without the change's files is missing objects, and nothing is fetched", async () => {
    const repo = changeRepo();
    git(repo.dir, "config", "uploadpack.allowFilter", "true");
    const parent = tempDir("oq-mb-partial-");
    git(parent, "clone", "-q", "--no-checkout", "--filter=blob:none", "--branch", "feature", `file://${repo.dir}`, "c");
    const clone = join(parent, "c");
    const before = git(clone, "count-objects", "-v");
    const model = fixtureModel();
    const result = await reviewChange({ clonePath: clone, mergeBaseSha: repo.base, headSha: repo.head }, model, options());
    expect(model.requests).toEqual([]);
    expect(result.status).toBe("incomplete");
    expect(result.reason).toMatch(/^missing objects: /);
    expect(git(clone, "count-objects", "-v")).toBe(before);
  });
});
