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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@openqodex/core";
import type { ContextItem } from "@openqodex/core";
import { reviewChange } from "../src/review-change.js";
import type { ModelReviewer, ReviewChangeInput } from "../src/reviewer.js";
import { recorded } from "./fixture-model.js";
import { stagedAnswer } from "./staged-fake.js";
import { changeRepo, git } from "./repos.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

// A provider that answers every staged brief with a passing answer, every
// scanner candidate dropped; `fail` makes every call throw.
function provider(fail = false): ModelReviewer {
  return {
    kind: "model", model: "honesty-fixture", maxOutputTokens: 4096,
    async complete(request) {
      if (fail) throw new Error("connection reset by the provider");
      const brief = request.messages.find((m) => m.role === "user")!.text;
      const fixed = JSON.parse(recorded(brief));
      for (const m of brief.matchAll(/^### (c\d+) \(scanner\)\n([\s\S]*?)(?=^### |^## )/gm)) {
        const at = /^- Location: (.+):(\d+)$/m.exec(m[2]!)!;
        fixed.dropped.push({ candidate: m[1], reason: "The function is internal and never exposed.", file_path: at[1], line_number: Number(at[2]) });
      }
      return { message: { text: stagedAnswer(brief, JSON.stringify(fixed), () => ""), toolCalls: [] }, usage: { model: "honesty-fixture", inputTokens: 10, outputTokens: 10 } };
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
