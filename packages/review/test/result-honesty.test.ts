// What a host reads off a staged model review through reviewChange, on a
// real git clone with a model provider stand-in: how much was examined, and
// why a review is not complete, as codes it can act on.
//
// Ways it could fail, written before the code:
//  1. A complete review does not say how many files and changed ranges a
//     reviewer was shown or read, so a host cannot tell it from one that
//     read nothing.
//  2. An incomplete review says why only in free text: a host cannot tell
//     a budget the host refused (do not retry) from a failed model call
//     (retry), a deadline (retry) or a brief too big for its inputs (the
//     same inputs fail the same way), nor which units were not examined.
//  3. A part of a large new file is cut to the unit diff budget alone, so
//     beside large context items its brief passes MAX_BRIEF_BYTES and its
//     ranges are named unread.
//  4. A result path leaves out the counts, ends complete with no changed
//     range examined (a change of binary files or renames only, given to a
//     model that reads nothing), or ends incomplete without a structured
//     cause. The paths are every return of reviewChange: a merge base not
//     proved, missing objects, a step that failed before the reviewer,
//     nothing to review, a change with no readable line, and a reviewed
//     change ending complete, complete_blocking or incomplete. The type of
//     the result builder (review-change.ts Untimed) keeps a new path from
//     leaving the cause out; this test runs each path that exists.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@openqodex/core";
import type { ContextItem } from "@openqodex/core";
import { reviewChange } from "../src/review-change.js";
import type { ModelReviewer, ReviewChangeInput, ReviewResult } from "../src/reviewer.js";
import { recorded } from "./fixture-model.js";
import type { Finding } from "./fixture-model.js";
import { stagedAnswer } from "./staged-fake.js";
import { changeRepo, git } from "./repos.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

// A provider that answers every staged brief with a passing answer, every
// scanner candidate dropped and `findings` raised; `fail` makes every call
// throw.
function provider(fail = false, findings: Finding[] = []): ModelReviewer {
  return {
    kind: "model", model: "honesty-fixture", maxOutputTokens: 4096,
    async complete(request) {
      if (fail) throw new Error("connection reset by the provider");
      const brief = request.messages.find((m) => m.role === "user")!.text;
      const fixed = JSON.parse(recorded(brief, findings));
      for (const m of brief.matchAll(/^### (c\d+) \(scanner\)\n([\s\S]*?)(?=^### |^## )/gm)) {
        const at = /^- Location: (.+):(\d+)$/m.exec(m[2]!)!;
        fixed.dropped.push({ candidate: m[1], reason: "The function is internal and never exposed.", file_path: at[1], line_number: Number(at[2]) });
      }
      // The quote a finder cites: the changed line of the demo's subtraction.
      const quote = (file: string, line: number) => file === "src/math.ts" && line === 2 ? "  return a - b;" : "";
      return { message: { text: stagedAnswer(brief, JSON.stringify(fixed), quote), toolCalls: [] }, usage: { model: "honesty-fixture", inputTokens: 10, outputTokens: 10 } };
    },
  };
}

// The demo change, with `big` lines of a new source file committed on top.
function repo(big = 0): { dir: string; base: string; head: string } {
  const r = changeRepo();
  if (big === 0) return r;
  writeFileSync(join(r.dir, "big.ts"), Array.from({ length: big }, (_, i) => `export const value${i + 1} = ${i + 1};`).join("\n") + "\n");
  git(r.dir, "add", "big.ts");
  git(r.dir, "commit", "-qm", "Add a large source file");
  return { ...r, head: git(r.dir, "rev-parse", "HEAD") };
}

async function review(r: { dir: string; base: string; head: string }, opts: { model?: ModelReviewer; authorize?: () => boolean; deadlineMs?: number; input?: Partial<ReviewChangeInput> } = {}) {
  return reviewChange({ clonePath: r.dir, mergeBaseSha: r.base, headSha: r.head, config: { ...DEFAULT_CONFIG, stages: true }, ...opts.input }, opts.model ?? provider(), {
    profile: "server", workDir: tempDir("oq-honest-work-"), installRoot: tempDir("oq-honest-tools-"), tools: { web: false, shell: false }, scanners: "preinstalled",
    budget: { deadlineMs: opts.deadlineMs ?? 120_000, authorize: async () => opts.authorize?.() ?? true },
  });
}

// Context items of 30 KB each, quoted in every brief.
const items = (n: number): ContextItem[] => Array.from({ length: n }, (_, i) => ({ kind: "lesson", text: `Lesson ${i}: ${"keep functions small and named. ".repeat(960)}`, source: `lessons ledger ${i}` }));

describe("the result says what a staged review examined and why it is not complete", () => {
  it("1. a complete review counts the files and changed ranges it examined", async () => {
    const result = await review(repo());
    expect(result.status, result.reason).toBe("complete");
    expect(result.reasonCode).toBeNull();
    expect(result.incomplete).toBeUndefined();
    // The demo change: one changed range in src/math.ts and one new db/x.sql.
    expect(result.filesExamined).toBe(2);
    expect(result.hunksExamined).toBe(result.coverage!.hunks);
    expect(result.hunksExamined).toBeGreaterThanOrEqual(2);
    expect(result.neighbourhood).toEqual({ partial: false, cause: null, droppedLinked: 0, droppedOther: 0 });
  });

  it("2. a budget the host refused is not retryable", async () => {
    const result = await review(repo(), { authorize: () => false });
    expect(result.status).toBe("incomplete");
    expect(result.reasonCode).toBe("budget_refused");
    expect(result.incomplete).toMatchObject({ cause: "budget_refused", retryable: false });
    expect(result.hunksExamined).toBe(0);
  });

  it("2. a model call that fails is retryable, and names the units it left unexamined", async () => {
    const result = await review(repo(), { model: provider(true) });
    expect(result.status).toBe("incomplete");
    expect(result.reason).toContain("connection reset by the provider");
    expect(result.incomplete).toMatchObject({ cause: "reviewer_failed", retryable: true, units: ["u1"] });
    // The verifier failed too, so the scanner candidate has no disposition.
    expect(result.incomplete!.causes).toEqual(["reviewer_failed", "candidates_not_disposed"]);
  });

  it("2. a deadline that passed before the finders started is retryable", async () => {
    const result = await review(repo(), { deadlineMs: 1 });
    expect(result.status).toBe("incomplete");
    expect(result.incomplete).toMatchObject({ cause: "deadline_timeout", retryable: true });
    expect(result.incomplete!.units).toContain("u1");
  });

  it("2. instructions and context items that leave no room for any part are brief_too_big, not retryable", async () => {
    const result = await review(repo(), { input: { context: items(4), instructions: "Keep the review strict. ".repeat(5400) } });
    expect(result.status).toBe("incomplete");
    expect(result.incomplete).toMatchObject({ cause: "brief_too_big", retryable: false });
    expect(result.reasonCode).toBe("brief_too_big");
  });

  it("3. a large new file beside 120 KB of context items is carried whole, every brief under MAX_BRIEF_BYTES", async () => {
    const result = await review(repo(13_000), { input: { context: items(4) } });
    expect(result.status, result.reason).toBe("complete");
    expect(result.coverage!.unread).toEqual([]);
    expect(result.notes.join("\n")).not.toContain("MAX_BRIEF_BYTES");
    expect(result.coverage!.given!.filter((g) => g.path === "big.ts").every((g) => g.by === "brief")).toBe(true);
    expect(result.hunksExamined).toBe(result.coverage!.hunks);
  });
});

const SUBTRACTION: Finding = { severity: "major", category: "bug", confidence: 0.9, file_path: "src/math.ts", line_number: 2, title: "Subtraction in add", problem: "The add function subtracts its second argument.", consequence: "Every caller gets a wrong sum.", fix: "Return a plus b.", source: null, candidate: null };

// The rules every result holds, whichever path made it.
function honest(result: ReviewResult): void {
  expect(Number.isInteger(result.filesExamined) && result.filesExamined >= 0).toBe(true);
  expect(Number.isInteger(result.hunksExamined) && result.hunksExamined >= 0).toBe(true);
  if (result.status === "complete" || result.status === "complete_blocking") {
    expect(result.hunksExamined).toBeGreaterThan(0);
    expect(result.filesExamined).toBeGreaterThan(0);
    expect(result.reasonCode).toBeNull();
    expect(result.incomplete).toBeUndefined();
  } else if (result.status === "incomplete") {
    expect(result.incomplete?.cause).toBeTruthy();
    expect(result.incomplete!.causes[0]).toBe(result.incomplete!.cause);
    expect(result.reasonCode).toBe(result.incomplete!.cause);
    expect(typeof result.incomplete!.retryable).toBe("boolean");
  } else {
    expect(result.status).toBe("nothing_to_review");
    expect(result).toMatchObject({ reasonCode: "nothing_to_review", filesExamined: 0, hunksExamined: 0 });
    expect(result.incomplete).toBeUndefined();
  }
}

describe("4. every result path is honest", () => {
  it("a merge base that is not an ancestor of the head: merge_base_unproven", async () => {
    const r = repo();
    const result = await review({ ...r, base: r.head, head: r.base });
    honest(result);
    expect(result.incomplete).toMatchObject({ cause: "merge_base_unproven", retryable: false });
  });

  it("a partial clone without the change's files: missing_objects", async () => {
    const r = repo();
    git(r.dir, "config", "uploadpack.allowFilter", "true");
    const parent = tempDir("oq-honest-partial-");
    git(parent, "clone", "-q", "--no-checkout", "--filter=blob:none", "--branch", "feature", `file://${r.dir}`, "c");
    const result = await review({ ...r, dir: join(parent, "c") });
    honest(result);
    expect(result.incomplete).toMatchObject({ cause: "missing_objects", retryable: false });
  });

  it("a head that holds the review's own packet folder: setup_failed", async () => {
    const r = repo();
    mkdirSync(join(r.dir, ".openqodex-review", "graph"), { recursive: true });
    writeFileSync(join(r.dir, ".openqodex-review", "graph", "index.md"), "planted\n");
    git(r.dir, "add", "-A");
    git(r.dir, "commit", "-qm", "Plant a packet folder");
    const result = await review({ ...r, head: git(r.dir, "rev-parse", "HEAD") });
    honest(result);
    expect(result.incomplete).toMatchObject({ cause: "setup_failed", retryable: false });
  });

  it("a head equal to the merge base: nothing_to_review", async () => {
    const r = repo();
    honest(await review({ ...r, head: r.base }));
  });

  it("a change of a binary file and a rename only: nothing_to_review, and no model call", async () => {
    const r = repo();
    git(r.dir, "checkout", "-q", "main");
    git(r.dir, "checkout", "-q", "-b", "assets");
    writeFileSync(join(r.dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]));
    git(r.dir, "mv", "src/use.ts", "src/usage.ts");
    git(r.dir, "add", "-A");
    git(r.dir, "commit", "-qm", "Add a logo and rename a file");
    let calls = 0;
    const model = provider();
    const complete = model.complete.bind(model);
    model.complete = (request) => { calls++; return complete(request); };
    const result = await review({ ...r, head: git(r.dir, "rev-parse", "HEAD") }, { model });
    honest(result);
    expect(result.status).toBe("nothing_to_review");
    expect(result.reason).toContain("no line a reviewer can read");
    expect(calls).toBe(0);
  });

  it("a reviewed change: complete, complete_blocking and incomplete", async () => {
    const complete = await review(repo());
    honest(complete);
    expect(complete.status).toBe("complete");
    const blocking = await review(repo(), { model: provider(false, [SUBTRACTION]), input: { config: { ...DEFAULT_CONFIG, stages: true, blockOnSeverity: "major" } } });
    honest(blocking);
    expect(blocking.status, blocking.reason).toBe("complete_blocking");
    const incomplete = await review(repo(), { deadlineMs: 1 });
    honest(incomplete);
    expect(incomplete.status).toBe("incomplete");
  });
});
