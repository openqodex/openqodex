// The contract an outside host relies on: reviewChange from the built
// library (dist/lib.js), called the way a host calls it, with
// previousReviewedSha, context items and scopes, on a real git clone. The
// model provider is the only stand-in: the stub the review package's tests
// use, which answers every staged brief from the brief itself, so no model
// call leaves the machine. Build first (`pnpm build`).
//
// Ways it could fail, written before the code:
//  1. A head the host already reviewed (previousReviewedSha equal to the
//     head) reads as a complete review instead of nothing to review, or
//     claims files or ranges examined.
//  2. A push that only merges main into the branch is reviewed again as
//     the branch's own change, or reads as complete.
//  3. About 100 KB of context items and 32 KB of instructions beside a new
//     1,700-line markdown file and a 1,700-line YAML file leave a range
//     unread, or end brief_too_big although every part fits a brief.
//  4. A one-line prose or config change in a repository of 273 files fills
//     the code around the change with prose words, so every brief says it
//     is partial.
//  5. An incomplete review gives no structured cause, or the wrong retry
//     answer: a brief too big for its inputs is retryable, or a deadline is
//     not.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { recorded } from "../../review/test/fixture-model.js";
import { stagedAnswer } from "../../review/test/staged-fake.js";
import { changeRepo, git } from "../../review/test/repos.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

type Lib = typeof import("../src/lib.js");
type Input = import("../src/lib.js").ReviewChangeInput;
type Reviewer = import("../src/lib.js").ModelReviewer;
type ContextItem = import("../src/lib.js").ContextItem;

const here = dirname(fileURLToPath(import.meta.url));
const lib = (): Promise<Lib> => import(join(dirname(here), "dist", "lib.js")) as Promise<Lib>;

// The stub provider: a passing answer to every brief, every scanner
// candidate dropped.
const stub: Reviewer = {
  kind: "model", model: "host-stub", maxOutputTokens: 4096,
  async complete(request) {
    const brief = request.messages.find((m) => m.role === "user")!.text;
    const fixed = JSON.parse(recorded(brief));
    for (const m of brief.matchAll(/^### (c\d+) \(scanner\)\n([\s\S]*?)(?=^### |^## )/gm)) {
      const at = /^- Location: (.+):(\d+)$/m.exec(m[2]!)!;
      fixed.dropped.push({ candidate: m[1], reason: "The function is internal and never exposed.", file_path: at[1], line_number: Number(at[2]) });
    }
    return { message: { text: stagedAnswer(brief, JSON.stringify(fixed), () => ""), toolCalls: [] }, usage: { model: "host-stub", inputTokens: 10, outputTokens: 10 } };
  },
};

async function review(input: Input, deadlineMs = 120_000) {
  const { reviewChange } = await lib();
  return reviewChange(input, stub, {
    profile: "server", workDir: tempDir("oq-host-work-"), installRoot: tempDir("oq-host-tools-"), tools: { web: false, shell: false }, scanners: "preinstalled",
    budget: { deadlineMs, authorize: async () => true },
  });
}

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
const commit = (dir: string, message: string): string => {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
};

// Context items of 25 KB each, quoted in every brief.
const items = (n: number): ContextItem[] => Array.from({ length: n }, (_, i) => ({ kind: "lesson", text: `Lesson ${i}: ${"keep each function small and named for what it does. ".repeat(480)}`, source: `lessons ledger ${i}` }));

describe("an outside host's calls to reviewChange", () => {
  it("1. a head the host already reviewed is nothing to review, with nothing examined", async () => {
    const repo = changeRepo();
    const result = await review({ clonePath: repo.dir, mergeBaseSha: repo.base, headSha: repo.head, previousReviewedSha: repo.head });
    expect(result).toMatchObject({ status: "nothing_to_review", reasonCode: "nothing_to_review", filesExamined: 0, hunksExamined: 0, neighbourhood: null });
    expect(result.scope?.kind).toBe("delta");
    expect(result.usage.calls).toEqual([]);
  });

  it("2. a push that only merges main is nothing to review", async () => {
    const repo = changeRepo();
    git(repo.dir, "checkout", "-q", "main");
    write(repo.dir, "src/main-only.ts", "export const fromMain = 1;\n");
    const mainTip = commit(repo.dir, "Main moves on");
    git(repo.dir, "checkout", "-q", "feature");
    git(repo.dir, "merge", "-q", "--no-edit", "main");
    const merged = git(repo.dir, "rev-parse", "HEAD");
    // The host's merge base is main's tip once the branch holds it.
    const result = await review({ clonePath: repo.dir, mergeBaseSha: mainTip, headSha: merged, previousReviewedSha: repo.head });
    expect(result).toMatchObject({ status: "nothing_to_review", filesExamined: 0, hunksExamined: 0 });
    expect(result.scope?.kind).toBe("delta");
  });

  it("3. 100 KB of context items and 32 KB of instructions beside a 1,700-line markdown file and a 1,700-line YAML file: every range carried", async () => {
    const repo = changeRepo();
    write(repo.dir, "docs/guide.md", Array.from({ length: 1700 }, (_, i) => `Step ${i + 1}: the service reads its settings, then answers each request in turn.`).join("\n") + "\n");
    write(repo.dir, "deploy/values.yaml", Array.from({ length: 1700 }, (_, i) => `setting_${i + 1}: "the value the service reads for setting ${i + 1}"`).join("\n") + "\n");
    const head = commit(repo.dir, "Add a guide and deployment values");
    const result = await review({ clonePath: repo.dir, mergeBaseSha: repo.base, headSha: head, context: items(4), instructions: "Flag any setting the guide does not explain. ".repeat(700), scopes: ["docs", "deploy"] });
    expect(result.incomplete?.causes ?? []).not.toContain("brief_too_big");
    expect(result.status, result.reason).toBe("complete");
    expect(result.coverage!.unread).toEqual([]);
    expect(result.filesExamined).toBe(2);
    expect(result.hunksExamined).toBe(result.coverage!.hunks);
  });

  it("4. a one-line prose change and a one-line config change in a 273-file repository write no partial note", async () => {
    const repo = changeRepo();
    // 150 of the files use the prose's words in long comment lines, so each
    // word would have a full set of sites to show.
    const prose = "Reviewers should read every changed line together with the callers around it before deciding whether the change keeps its promises to the rest of the service and its users";
    for (let i = 0; i < 271; i++) {
      const comment = i < 150 ? `// ${prose} ${"padding ".repeat(20)}` : "// unrelated";
      write(repo.dir, `src/mod${i}.ts`, `${comment}\nexport const value${i} = ${i};\n${comment}\n${comment}\n`);
    }
    write(repo.dir, "README.md", "# Service\n\nOld text.\n");
    write(repo.dir, "config.yaml", "retry_limit: 2\n");
    const base = commit(repo.dir, "A larger repository");
    write(repo.dir, "README.md", `# Service\n\n${prose}.\n`);
    write(repo.dir, "config.yaml", "retry_limit: 3\n");
    const head = commit(repo.dir, "Edit the readme and a setting");
    const result = await review({ clonePath: repo.dir, mergeBaseSha: base, headSha: head });
    expect(result.status, result.reason).toBe("complete");
    expect(result.notes.join("\n")).not.toContain("Code around the change is partial");
    // No name was cut at all: the prose words never became names.
    expect(result.neighbourhood).toEqual({ partial: false, cause: null, droppedLinked: 0, droppedOther: 0 });
  });

  it("5. a brief too big for its inputs is not retryable; a deadline is", async () => {
    const repo = changeRepo();
    const tooBig = await review({ clonePath: repo.dir, mergeBaseSha: repo.base, headSha: repo.head, context: items(5), instructions: "Keep the review strict. ".repeat(5400) });
    expect(tooBig).toMatchObject({ status: "incomplete", reasonCode: "brief_too_big", incomplete: { cause: "brief_too_big", retryable: false } });
    const late = await review({ clonePath: repo.dir, mergeBaseSha: repo.base, headSha: repo.head }, 1);
    expect(late).toMatchObject({ status: "incomplete", reasonCode: "deadline_timeout", incomplete: { cause: "deadline_timeout", retryable: true } });
  });
});
