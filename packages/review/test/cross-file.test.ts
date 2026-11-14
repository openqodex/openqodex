// Cross-file evidence in the staged review, through reviewChange on a real
// git clone: the interfaces finder is shown the callers of a changed
// declaration in other files, the verifier is shown the lines a candidate
// cites in another file, and a confirmed finding keeps those citations. The
// model provider is the only stand-in; the brain, the graph, the snapshot,
// the checks and the renderers are real.
//
// Ways it could fail, written before the code:
//  1. The interfaces (contracts) finder brief for a change to an exported
//     function holds no caller range from another file, so the finder judges
//     the new contract without the code that relies on the old one.
//  2. The verifier of a candidate whose evidence cites file B gets only the
//     candidate's own file, so it confirms or refutes without B's lines.
//  3. The confirmed finding loses the other file its evidence rests on: the
//     result, the JSON report or the rendered report does not name it.
//  4. A finding whose evidence is all in its own file changes: it gains an
//     evidence field or an "Evidence in other files" line.
//  5. A cited path outside the repository, under .git, a link, or missing
//     from the snapshot is read into a verifier brief.
//  6. A declaration with hundreds of callers floods the brief: every caller
//     is shown, the brief grows past the neighbourhood's byte budget, or the
//     cut is silent.
//  7. Two changed files each declare a function of the same name: their
//     callers are pooled under one declaration, so the second declaration is
//     never shown and its caller falls past the first one's cap.
//  8. The confirmed finding keeps a line in another file that its candidate
//     cited but the verifier did not rely on.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@openqodex/core";
import type { VerifyCandidate } from "@openqodex/core";
import { reviewChange } from "../src/review-change.js";
import { CITED_BLOCK_BYTES, CONTRACT_CALLERS, CONTRACTS_BLOCK_BYTES, NEIGHBOURHOOD_BLOCK_BYTES, renderCitedBlock } from "../src/neighbourhood.js";
import { MAX_BRIEF_BYTES } from "../src/units.js";
import type { ModelRequest, ModelReviewer, ReviewResult } from "../src/reviewer.js";
import { git } from "./repos.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const BASE_USERS = "export type User = { id: string; name: string };\nconst users = new Map<string, User>();\nexport function findUser(id: string): User {\n  const user = users.get(id);\n  if (!user) throw new Error(`no user ${id}`);\n  return user;\n}\n";
// The head: findUser may now return undefined (lines 3 and 4 changed).
const HEAD_USERS = "export type User = { id: string; name: string };\nconst users = new Map<string, User>();\nexport function findUser(id: string): User | undefined {\n  return users.get(id);\n}\n";
// The unchanged caller: line 5 reads a field of the result.
const GREET = 'import { findUser } from "./users";\n\nexport function greet(id: string): string {\n  const user = findUser(id);\n  return `Hello ${user.name}`;\n}\n';

type Repo = { dir: string; base: string; head: string };

// A base commit of `base` and a head commit that writes `head` over it.
function commits(base: Record<string, string>, head: Record<string, string>): Repo {
  const dir = tempDir("oq-xf-repo-");
  git(dir, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(base)) write(dir, path, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  const sha = git(dir, "rev-parse", "HEAD");
  for (const [path, text] of Object.entries(head)) write(dir, path, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Change");
  return { dir, base: sha, head: git(dir, "rev-parse", "HEAD") };
}

// A base commit with findUser and its caller in another file, and a head
// commit that changes findUser's contract. `callers`: that many more files
// that call findUser, unchanged.
function repo(callers = 0): Repo {
  const base: Record<string, string> = { "src/users.ts": BASE_USERS, "src/greet.ts": GREET };
  for (let i = 0; i < callers; i++) base[`src/callers/c${i}.ts`] = `import { findUser } from "../users";\n\nexport const name${i} = () => findUser("u${i}");\n`;
  return commits(base, { "src/users.ts": HEAD_USERS });
}

type Citation = { file_path: string; line_number: number; quote: string };
// `relied`: the lines in other files the verifier says its verdict rests on.
type Raised = { pass: "local" | "contracts"; line: number; title: string; evidence: Citation[]; relied?: { file_path: string; line_number: number }[] };

const CROSS: Raised = {
  pass: "contracts", line: 3, title: "Caller reads a field of a missing user",
  evidence: [
    { file_path: "src/users.ts", line_number: 3, quote: "export function findUser(id: string): User | undefined {" },
    { file_path: "src/greet.ts", line_number: 5, quote: "return `Hello ${user.name}`;" },
  ],
  relied: [{ file_path: "src/greet.ts", line_number: 5 }],
};
const LOCAL: Raised = {
  pass: "local", line: 4, title: "Lookup no longer throws",
  evidence: [{ file_path: "src/users.ts", line_number: 4, quote: "return users.get(id);" }],
};

// The model provider: each finder pass raises the candidates given for it,
// and the verifier confirms every finder candidate, relying on the lines in
// `relied`. It keeps every brief.
function provider(raised: Raised[]): ModelReviewer & { finds: Map<string, string>; contracts: string[]; verifies: string[] } {
  const finds = new Map<string, string>();
  const contracts: string[] = [];
  const verifies: string[] = [];
  return {
    kind: "model", model: "fixture-model", maxOutputTokens: 4096, finds, contracts, verifies,
    async complete(request: ModelRequest) {
      const brief = request.messages.find((m) => m.role === "user")?.text ?? "";
      const changeId = /`change_id`: `([0-9a-f]{12})`/.exec(brief)?.[1] ?? "missing";
      let answer: unknown;
      if (brief.startsWith("# OpenQodex review brief: find pass")) {
        const pass = /^Pass: (local|contracts)$/m.exec(brief)![1]! as Raised["pass"];
        finds.set(pass, brief);
        if (pass === "contracts") contracts.push(brief);
        const hunks = [...brief.matchAll(/^### (h\d+) /gm)].map((m) => m[1]!);
        answer = {
          version: "find-1", change_id: changeId, unit: /^Unit: (u\d+)$/m.exec(brief)![1], examined: hunks,
          analysis: hunks.map((hunk) => ({ hunk, changed: "The lookup changed.", could_break: "A caller can get no user." })),
          candidates: raised.filter((r) => r.pass === pass).map((r) => ({ severity: "major", category: "bug", confidence: 0.9, file_path: "src/users.ts", line_number: r.line, title: r.title, claim: "The lookup can return no user. A caller then reads a field of nothing.", evidence: r.evidence })),
        };
      } else {
        verifies.push(brief);
        const ids = [...brief.matchAll(/^### (k\d+) \(finder\)\n[\s\S]*?^- Location: src\/users\.ts:(\d+)$[\s\S]*?^- Title: (.*)$/gm)];
        answer = {
          version: "verify-1", change_id: changeId,
          verdicts: ids.map((m) => ({ id: m[1], verdict: "confirmed", reason: `src/users.ts:${m[2]} returns the lookup result unchecked.`, duplicate_of: null, severity: "major", category: "bug", confidence: 0.9, file_path: "src/users.ts", line_number: Number(m[2]), title: m[3], problem: "The lookup can return no user.", consequence: "The greeting then fails at run time.", fix: "Check the result before reading its name.", suggested_change: null, tier: "finding", relied_on: raised.find((r) => r.title === m[3])?.relied ?? null })),
        };
      }
      return { message: { text: JSON.stringify(answer), toolCalls: [] }, usage: { model: "fixture-model", inputTokens: 100, outputTokens: 50, costUsd: 0.001 } };
    },
  };
}

async function review(raised: Raised[], callers = 0, r: Repo = repo(callers)): Promise<{ result: ReviewResult; model: ReturnType<typeof provider> }> {
  const model = provider(raised);
  const result = await reviewChange({ clonePath: r.dir, mergeBaseSha: r.base, headSha: r.head, config: { ...DEFAULT_CONFIG, stages: true } }, model, {
    profile: "server", workDir: tempDir("oq-xf-work-"), installRoot: tempDir("oq-xf-install-"), tools: { web: false, shell: false }, scanners: "preinstalled",
    budget: { deadlineMs: 120_000, authorize: async () => true },
  });
  return { result, model };
}

// The text of one "## " block of a brief, up to the next one.
function block(brief: string, heading: string): string {
  const start = brief.indexOf(`\n${heading}\n`);
  if (start === -1) return "";
  const next = brief.slice(start + 1).search(/\n## (?!#)/);
  return next === -1 ? brief.slice(start + 1) : brief.slice(start + 1, start + 1 + next);
}

describe("cross-file evidence in the staged review", () => {
  it("1, 2, 3, 4. shows the caller to the interfaces finder and the verifier, and keeps the citation on the finding", async () => {
    const { result, model } = await review([CROSS, LOCAL]);
    expect(result.status, result.reason).toMatch(/^complete/);

    // 1. The callers block names the declaration and the caller's lines.
    const contracts = block(model.finds.get("contracts")!, "## Callers of the changed declarations");
    expect(contracts).toContain("### findUser, declared at src/users.ts:3");
    expect(contracts).toMatch(/at src\/greet\.ts:4 \(/);
    expect(contracts).toContain("4\t  const user = findUser(id);");
    expect(contracts).toContain("5\t  return `Hello ${user.name}`;");
    expect(model.finds.get("local")).not.toContain("## Callers of the changed declarations");

    // 2. The verifier gets the cited range of the other file.
    const verify = model.verifies.join("\n");
    const cited = block(verify, "## Cited code in other files");
    expect(cited).toMatch(/### k\d+ cites src\/greet\.ts:5/);
    expect(cited).toContain("5\t  return `Hello ${user.name}`;");
    expect(cited).toContain("3\texport function greet(id: string): string {");

    // 3. The finding keeps the other file, in the result and the reports.
    const cross = result.findings.find((f) => f.title === CROSS.title)!;
    expect(cross.evidence).toEqual([{ file: "src/greet.ts", line: 5 }]);
    const json = JSON.parse(result.render.json()) as { findings: { title: string; evidence?: unknown }[] };
    expect(json.findings.find((f) => f.title === CROSS.title)!.evidence).toEqual([{ file_path: "src/greet.ts", line_number: 5 }]);
    expect(result.render.markdown()).toContain("**Evidence in other files:** src/greet.ts:5");

    // 4. A finding with evidence in its own file only is as it was.
    const local = result.findings.find((f) => f.title === LOCAL.title)!;
    expect(local).toBeDefined();
    expect("evidence" in local).toBe(false);
    expect("evidence" in json.findings.find((f) => f.title === LOCAL.title)!).toBe(false);
    expect(result.render.markdown().match(/Evidence in other files/g)).toHaveLength(1);
  }, 120_000);

  it("5. refuses a candidate whose evidence cites a path outside the repository", async () => {
    const outside: Raised = { ...CROSS, evidence: [CROSS.evidence[0]!, { file_path: "../outside.ts", line_number: 1, quote: "outside" }] };
    const { result, model } = await review([outside]);
    expect(result.findings.map((f) => f.title)).not.toContain(CROSS.title);
    expect(model.verifies.join("\n")).not.toContain("outside.ts");
  }, 120_000);

  it("5. reads no cited line outside the snapshot, under .git, through a link or from a missing file", () => {
    const root = tempDir("oq-xf-cited-");
    const snapshot = join(root, "tree");
    write(root, "outside.ts", "OUTSIDE MARKER\n");
    write(snapshot, "src/users.ts", HEAD_USERS);
    write(snapshot, "src/greet.ts", GREET);
    write(snapshot, ".git/config", "GIT MARKER\n");
    symlinkSync(join(root, "outside.ts"), join(snapshot, "src/link.ts"));
    const cite = (file_path: string): Citation => ({ file_path, line_number: 1, quote: "x" });
    const candidate: VerifyCandidate = { id: "k1", kind: "finder", foundBy: ["finder:u1:contracts"], candidate: { severity: "major", category: "bug", confidence: 0.9, file_path: "src/users.ts", line_number: 3, title: "t", claim: "c", evidence: [cite("../outside.ts"), cite(join(root, "outside.ts")), cite(".git/config"), cite("src/link.ts"), cite("src/missing.ts"), cite("src/greet.ts")] } };
    const text = renderCitedBlock(snapshot, { file: "src/users.ts", candidates: [candidate] }, []);
    expect(text).not.toContain("MARKER");
    expect(text).toContain("### k1 cites src/greet.ts:1");
    for (const path of ["../outside.ts", ".git/config", "src/link.ts", "src/missing.ts"]) expect(text).toContain(`${path}:1 (not a text file in the snapshot)`);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CITED_BLOCK_BYTES);
  });

  it("6. cuts a declaration with hundreds of callers to the cap and says so, within the brief's budget", async () => {
    const { model } = await review([], 300);
    const brief = model.finds.get("contracts")!;
    const contracts = block(brief, "## Callers of the changed declarations");
    const shown = contracts.match(/^(?:caller|use) at /gm) ?? [];
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThanOrEqual(CONTRACT_CALLERS);
    expect(contracts).toMatch(new RegExp(`The name appears at \\d+ sites in 301 other files\\. ${shown.length} shown; \\d+ cut at the cap of ${CONTRACT_CALLERS} per declaration`));
    expect(Buffer.byteLength(contracts)).toBeLessThanOrEqual(CONTRACTS_BLOCK_BYTES);
    expect(Buffer.byteLength(contracts) + Buffer.byteLength(block(brief, "## Code around the change"))).toBeLessThanOrEqual(NEIGHBOURHOOD_BLOCK_BYTES + 4);
    expect(Buffer.byteLength(brief)).toBeLessThan(MAX_BRIEF_BYTES);
  }, 180_000);

  it("8. keeps on the finding only the cited lines in other files the verifier relied on", async () => {
    const both: Raised = { ...CROSS, evidence: [...CROSS.evidence, { file_path: "src/greet.ts", line_number: 4, quote: "const user = findUser(id);" }] };
    const { result, model } = await review([both]);
    expect(result.status, result.reason).toMatch(/^complete/);
    expect(model.verifies.join("\n")).toContain("- `relied_on`: for a confirmed finder candidate, the lines its evidence cites in other files");
    expect(result.findings.find((f) => f.title === CROSS.title)!.evidence).toEqual([{ file: "src/greet.ts", line: 5 }]);

    const none = await review([{ ...both, relied: [] }]);
    const finding = none.result.findings.find((f) => f.title === CROSS.title)!;
    expect(finding).toBeDefined();
    expect("evidence" in finding).toBe(false);
  }, 180_000);

  it("7. shows each of two changed declarations of one name with its own callers", async () => {
    const parse = (returns: string, body: string) => `export function parse(text: string): ${returns} {\n  return ${body};\n}\n`;
    const base: Record<string, string> = { "src/a.ts": parse("number", "Number(text)"), "src/b.ts": parse("string[]", 'text.split(",")') };
    // Nine callers of a.ts's parse fill its cap before z.ts, the one caller of b.ts's.
    for (let i = 0; i < 9; i++) base[`src/a-callers/c${i}.ts`] = `import { parse } from "../a";\n\nexport const n${i} = () => parse("${i}");\n`;
    base["src/z.ts"] = 'import { parse } from "./b";\n\nexport const parts = () => parse("x,y");\n';
    const r = commits(base, { "src/a.ts": parse("number | null", "text ? Number(text) : null"), "src/b.ts": parse("string[] | null", 'text ? text.split(",") : null') });
    const { result, model } = await review([], 0, r);
    expect(result.status, result.reason).toMatch(/^complete/);
    const entries = model.contracts.flatMap((brief) => block(brief, "## Callers of the changed declarations").split(/\n(?=### )/).slice(1));
    const declaredIn = (path: string) => entries.filter((e) => e.startsWith(`### parse, declared at ${path}:1`));
    expect(declaredIn("src/a.ts")).toHaveLength(1);
    expect(declaredIn("src/b.ts")).toHaveLength(1);
    const [a] = declaredIn("src/a.ts");
    const [b] = declaredIn("src/b.ts");
    expect(a).toContain("1\texport function parse(text: string): number | null {");
    expect(a).toMatch(/caller at src\/a-callers\/c0\.ts:3 \(from the code graph\)/);
    expect(b).toContain("1\texport function parse(text: string): string[] | null {");
    expect(b).toMatch(/caller at src\/z\.ts:3 \(from the code graph\)/);
    // The graph ties each call to its own declaration; an import line stays an unverified name match for both.
    expect(a).not.toMatch(/at src\/z\.ts:3 /);
    expect(b).not.toMatch(/at src\/a-callers\/c\d\.ts:3 /);
  }, 180_000);
});
