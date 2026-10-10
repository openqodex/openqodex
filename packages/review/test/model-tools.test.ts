// The five tools the brain gives a model reviewer, run on a real snapshot
// folder (a git repository with one change), a real diff and a real code
// graph. Nothing is a stand-in here: the tools are plain functions over the
// folder.
//
// Ways it could fail, written before the code:
//  1. read_file hands out lines numbered differently from the snapshot, or
//     records a range other than the lines it carried.
//  2. A path outside the snapshot (a `..` step, an absolute path, `~`, a
//     `..` step spelled with a backslash) is read, or is refused without
//     being marked outside.
//  3. A link is followed: to a file outside, or to one inside.
//  4. The `.git` entry of the snapshot (it names the clone's folder) is read.
//  5. A reply passes the 32 KB bound, or a cut reply does not say which lines
//     it carried.
//  6. A single line longer than the bound is cut in the middle instead of
//     refused.
//  7. A secret the scanners found reaches a reply: through read_file,
//     search_code, list_files or read_diff_for_file (the diff comes from git,
//     unredacted), or through the log of a call's arguments.
//  7b. search_code is an oracle on a secret: a pattern aimed at it (its
//     prefix, the redaction marker, the rest of its line) gets an answer, a
//     line or a count, that differs from a miss. The folder below is not
//     redacted beforehand, so the tools' own redacted views are what is
//     tested.
//  8. search_code runs a program, or hands the reviewer's pattern to an
//     engine that backtracks, so a pattern can hang the review; or a
//     construct only a backtracking engine runs is accepted silently.
//  8b. The matcher answers differently from JavaScript's own engine for the
//     syntax it takes.
//  9. search_code or list_files with a glob rooted outside the snapshot runs.
// 10. list_files lists `.git` or a link.
// 11. read_diff_for_file serves a file outside the change, or the diff of a
//     file in the change is missing.
// 12. find_callers answers from anything but the graph's query layer, or
//     pretends to answer when there is no graph.
// 13. A tool name the brain did not define is run or is logged as inside.
// 14. Bad arguments are run, or are logged as an attempt outside.
// 15. A pattern or a glob makes the brain do unbounded work: a pattern
//     over its length limit, a pattern that backtracks without end elsewhere, a glob of
//     100 brace lists or of many `**` steps, a listing or a search over a
//     snapshot of 20,000 files. Each must end under a fixed time, and a call
//     that stops at a bound must say so in its reply and its log reason.
// 16. With folder scopes, a tool reads, lists, searches or finds callers in
//     a path outside them, logs such a call as in scope, or refuses the
//     graph's packet folder the brief tells the reviewer to read.
// 17. A call's arguments of any size are read, logged or echoed whole, or a
//     refusal that echoes an argument passes the 32 KB bound.
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTreeChange } from "@openqodex/core";
import type { Change } from "@openqodex/core";
import { buildGraph } from "@openqodex/graph";
import { TOOL_ARGS_BYTES, TOOL_DEFINITIONS, TOOL_REPLY_BYTES, WALK_FILES, runTool } from "../src/tools/index.js";
import { compileGlob, compilePattern, matchesLine } from "../src/tools/pattern.js";
import type { ToolBox } from "../src/tools/index.js";
import { admitted } from "../src/scopes.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const SECRET = ["sk", "live", "51ExampleSyntheticNotAKey0000"].join("_");

let box: ToolBox;
let outside: string;
let change: Change;

beforeAll(async () => {
  const dir = tempDir("oq-tools-");
  outside = tempDir("oq-tools-outside-");
  writeFileSync(join(outside, "secret.txt"), "outside the snapshot\n");
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  writeFileSync(join(dir, "src/use.ts"), 'import { add } from "./math";\n\nexport function total(xs: number[]): number {\n  return xs.reduce((s, x) => add(s, x), 0);\n}\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  writeFileSync(join(dir, "src/config.ts"), `export const key = "${SECRET}";\n`);
  // 3000 numbered lines of 20 characters: about 60 KB, so one reply cannot carry them all.
  writeFileSync(join(dir, "src/long.txt"), Array.from({ length: 3000 }, (_, i) => `line ${String(i + 1).padStart(14, "0")}`).join("\n") + "\n");
  writeFileSync(join(dir, "src/wide.txt"), `${"x".repeat(TOOL_REPLY_BYTES + 10)}\nshort\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Change");
  const head = git(dir, "rev-parse", "HEAD");
  // Links are made after the commit: a snapshot written by openqodex never
  // holds one, so these test the tools' own refusal.
  symlinkSync(join(outside, "secret.txt"), join(dir, "src/out-link.txt"));
  symlinkSync(join(dir, "src/math.ts"), join(dir, "src/in-link.ts"));
  change = await getTreeChange({ repoRoot: dir, baseRef: base, baseSha: base, headSha: head, exclude: [] });
  const graph = await buildGraph({ repoRoot: dir, store: null, capture: null });
  box = { snapshotDir: dir, change, secrets: [SECRET], graph, graphNote: null };
});

describe("the tool definitions", () => {
  it("define exactly the five tools, each with a plain description and a closed schema", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual(["read_file", "search_code", "list_files", "read_diff_for_file", "find_callers"]);
    for (const t of TOOL_DEFINITIONS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.description).not.toMatch(/\u2014/);
      expect(t.parameters).toMatchObject({ type: "object", additionalProperties: false });
      for (const r of t.parameters.required) expect(Object.keys(t.parameters.properties)).toContain(r);
    }
  });
});

describe("read_file", () => {
  it("1. carries the lines numbered as the snapshot holds them and records that range", async () => {
    const r = await runTool(box, "read_file", { path: "src/use.ts", start: 3, lines: 2 });
    expect(r).toMatchObject({ ok: true, inside: true, path: "src/use.ts", range: [3, 4], reason: null });
    expect(r.text).toBe("src/use.ts lines 3 to 4 of 5\n3\texport function total(xs: number[]): number {\n4\t  return xs.reduce((s, x) => add(s, x), 0);");
  });

  it("2. refuses a path outside the snapshot and marks the attempt outside", async () => {
    // The outside folder is the snapshot's sibling, so a backslash step reaches it.
    const sibling = `..\\${basename(outside)}\\secret.txt`;
    for (const path of ["../x.ts", join(outside, "secret.txt"), "~/.ssh/id_rsa", "src/../../x", sibling, `src\\..\\${sibling}`]) {
      const r = await runTool(box, "read_file", { path });
      expect(r, path).toMatchObject({ ok: false, inside: false, range: null });
      expect(r.reason, path).toMatch(/outside/);
      expect(r.text).not.toContain("outside the snapshot\n");
    }
  });

  it("3. never follows a link: one that leads outside is outside, one that stays inside is refused", async () => {
    const out = await runTool(box, "read_file", { path: "src/out-link.txt" });
    expect(out).toMatchObject({ ok: false, inside: false });
    expect(out.text).not.toContain("outside the snapshot\n");
    const inner = await runTool(box, "read_file", { path: "src/in-link.ts" });
    expect(inner).toMatchObject({ ok: false, inside: true, range: null });
    expect(inner.reason).toMatch(/link/);
    expect(inner.text).not.toContain("return");
  });

  it("4. never reads the .git entry", async () => {
    for (const path of [".git", ".git/config", ".git/HEAD"]) {
      const r = await runTool(box, "read_file", { path });
      expect(r, path).toMatchObject({ ok: false, inside: true });
      expect(r.reason, path).toMatch(/\.git/);
    }
  });

  it("5. cuts a reply over 32 KB at a whole line and records the lines it carried", async () => {
    const r = await runTool(box, "read_file", { path: "src/long.txt" });
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(TOOL_REPLY_BYTES);
    expect(r.ok).toBe(true);
    const [first, last] = r.range!;
    expect(first).toBe(1);
    expect(last).toBeGreaterThan(1000);
    expect(last).toBeLessThan(3000);
    expect(r.reason).toBe(`cut at 32 KB: lines 1 to ${last} of 3000 sent; ask for line ${last + 1} onward`);
    expect(r.text.split("\n").at(-1)).toBe(`${last}\tline ${String(last).padStart(14, "0")}`);
    const next = await runTool(box, "read_file", { path: "src/long.txt", start: last + 1 });
    expect(next.range![0]).toBe(last + 1);
  });

  it("6. refuses a line longer than the bound instead of cutting it", async () => {
    const r = await runTool(box, "read_file", { path: "src/wide.txt" });
    expect(r).toMatchObject({ ok: false, inside: true, range: null });
    expect(r.reason).toMatch(/line 1 is longer than the 32 KB/);
    const second = await runTool(box, "read_file", { path: "src/wide.txt", start: 2 });
    expect(second).toMatchObject({ ok: true, range: [2, 2] });
  });

  it("7. never hands out a secret the scanners found: the line comes back redacted", async () => {
    const r = await runTool(box, "read_file", { path: "src/config.ts" });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('src/config.ts lines 1 to 1 of 1\n1\texport const key = "[redacted]";');
  });
});

describe("search_code", () => {
  it("finds matching lines by path and line, from text files only", async () => {
    const r = await runTool(box, "search_code", { pattern: "add\\(", glob: "src/**" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("src/use.ts:4:");
    expect(r.text).not.toContain(".git");
  });

  it("7b. a pattern aimed at a secret gets exactly the answer a miss gets", async () => {
    const miss = await runTool(box, "search_code", { pattern: "zz_no_such_text_zz" });
    expect(miss).toMatchObject({ ok: true, reason: null });
    expect(miss.text).toBe("0 matches in 5 files");
    for (const pattern of ["sk_live", SECRET.slice(0, 12), "sk_live_51[A-Z]", "\\[redacted\\]", "export const key", SECRET]) {
      const r = await runTool(box, "search_code", { pattern });
      expect({ text: r.text, ok: r.ok, reason: r.reason }, pattern).toEqual({ text: miss.text, ok: miss.ok, reason: miss.reason });
    }
  });

  it("7. the log keeps a search's arguments redacted", async () => {
    const r = await runTool(box, "search_code", { pattern: SECRET });
    expect(r.detail).not.toContain(SECRET);
    expect(r.detail).toContain("[redacted]");
  });

  it("8. refuses, with the reason, a pattern only a backtracking engine can run", async () => {
    for (const pattern of ["(x+)\\1", "(?<n>x)\\k<n>", "a(?=b)", "(?<!a)b", "a(?!b)"]) {
      const r = await runTool(box, "search_code", { pattern });
      expect(r, pattern).toMatchObject({ ok: false, inside: true });
      expect(r.reason, pattern).toMatch(/backreference or a lookaround/);
    }
  });

  it("8. runs a pattern that backtracks without end elsewhere in time bounded by the line", async () => {
    const started = Date.now();
    const r = await runTool(box, "search_code", { pattern: "^(x+x+)+y$", glob: "src/wide.txt" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r).toMatchObject({ ok: true, reason: null });
    expect(r.text).toBe("0 matches in 1 file");
  });

  it("8b. matches where JavaScript's own engine matches, for the syntax it takes", () => {
    const patterns = ["add\\(", "^\\s*return", "a|b|xyz", "(ab)+c", "[a-c]{2,3}d", "\\bend\\b", "\\Bnd", "x?y*z+", "colou?r", "[^0-9 ]+$", "\\d{3}-\\d{2}", "\\w+@\\w+\\.com", "(?:foo|bar)baz", "a.c", "\\x41\\u0042", "[\\d-]+", "\\$\\{x\\}", "^$", "a{2}", "a{1,}b", "(a|)+b", "(a*)*c", "[.]", "a\\.b", "{x}", "a{,2}", "[]", "[^]"];
    const lines = ["return add(1, 2);", "  return x", "xyz", "ababc", "abcd bbd", "the end.", "bend", "yyyz", "color colour", "abc", "123-45", "me@host.com", "foobaz barbaz", "abc a-c", "AB", "1-2-3", "${x}", "", "aa", "aaab", "b", "aaac", "x.y", "a.b", "{x}", "a{,2}", "anything"];
    for (const p of patterns) {
      const compiled = compilePattern(p);
      expect("program" in compiled, p).toBe(true);
      const program = (compiled as { program: Parameters<typeof matchesLine>[0] }).program;
      const re = new RegExp(p);
      for (const line of lines) expect(matchesLine(program, line), `${p} on ${JSON.stringify(line)}`).toBe(re.test(line));
    }
  });

  it("refuses a pattern whose matcher would be too large", () => {
    expect(compilePattern("(a{1000}){1000}")).toEqual({ refused: expect.stringMatching(/too large/) });
  });

  it("9. refuses a glob rooted outside the snapshot", async () => {
    for (const glob of ["/etc/*", "../**", "~/**"]) {
      const r = await runTool(box, "search_code", { pattern: "x", glob });
      expect(r, glob).toMatchObject({ ok: false, inside: false });
    }
  });

  it("refuses a pattern that is not a regular expression", async () => {
    const r = await runTool(box, "search_code", { pattern: "(" });
    expect(r).toMatchObject({ ok: false, inside: true });
    expect(r.reason).toMatch(/regular expression/);
  });
});

describe("list_files", () => {
  it("10. lists the snapshot's regular files only: no .git, no link", async () => {
    const r = await runTool(box, "list_files", {});
    expect(r.ok).toBe(true);
    const listed = r.text.split("\n").slice(1);
    expect(listed).toEqual(["src/config.ts", "src/long.txt", "src/math.ts", "src/use.ts", "src/wide.txt"]);
    const ts = await runTool(box, "list_files", { glob: "src/*.ts" });
    expect(ts.text.split("\n").slice(1)).toEqual(["src/config.ts", "src/math.ts", "src/use.ts"]);
  });

  it("9. refuses a glob rooted outside the snapshot", async () => {
    const r = await runTool(box, "list_files", { glob: "/**" });
    expect(r).toMatchObject({ ok: false, inside: false });
  });
});

describe("read_diff_for_file", () => {
  it("11. serves the diff of a changed file, redacted, and refuses any other file", async () => {
    const r = await runTool(box, "read_diff_for_file", { path: "src/math.ts" });
    expect(r).toMatchObject({ ok: true, inside: true, path: "src/math.ts" });
    expect(r.text).toContain("-  return a + b;");
    expect(r.text).toContain("+  return a - b;");
    const secret = await runTool(box, "read_diff_for_file", { path: "src/config.ts" });
    expect(secret.ok).toBe(true);
    expect(secret.text).not.toContain(SECRET);
    const other = await runTool(box, "read_diff_for_file", { path: "src/use.ts" });
    expect(other).toMatchObject({ ok: false, inside: true });
    expect(other.reason).toMatch(/not a changed file/);
    const out = await runTool(box, "read_diff_for_file", { path: "../x.ts" });
    expect(out).toMatchObject({ ok: false, inside: false });
  });
});

describe("find_callers", () => {
  it("12. answers from the code graph's query layer", async () => {
    const r = await runTool(box, "find_callers", { symbol: "add", file: "src/math.ts" });
    expect(r).toMatchObject({ ok: true, inside: true, path: "src/math.ts" });
    expect(r.text).toMatch(/src\/use\.ts:4/);
    expect(r.text).toMatch(/total/);
  });

  it("12. says so when the symbol is not in the graph, and when there is no graph", async () => {
    const missing = await runTool(box, "find_callers", { symbol: "nothing", file: "src/math.ts" });
    expect(missing).toMatchObject({ ok: false, inside: true });
    const none = await runTool({ ...box, graph: null, graphNote: "the code graph was skipped: no changed file is code" }, "find_callers", { symbol: "add", file: "src/math.ts" });
    expect(none).toMatchObject({ ok: false, inside: true });
    expect(none.reason).toMatch(/no code graph/);
  });
});

describe("calls the brain cannot run", () => {
  it("13. a tool name the brain did not define is refused and has no place", async () => {
    const r = await runTool(box, "run_shell", { command: "cat /etc/passwd" });
    expect(r).toMatchObject({ ok: false, inside: null, path: null, tool: "run_shell" });
    expect(r.reason).toMatch(/not a tool/);
  });

  it("14. bad arguments are refused without being taken for an attempt outside", async () => {
    for (const [name, args] of [
      ["read_file", { path: 7 }],
      ["read_file", {}],
      ["read_file", { path: "src/math.ts", start: 0 }],
      ["read_file", "not an object"],
      ["search_code", { glob: "src/**" }],
      ["find_callers", { symbol: "add" }],
    ] as const) {
      const r = await runTool(box, name, args);
      expect(r, JSON.stringify(args)).toMatchObject({ ok: false, inside: true, path: null });
      expect(r.reason, JSON.stringify(args)).toMatch(/^bad arguments/);
    }
  });

  it("reads a JSON text holding one object as that object", async () => {
    const r = await runTool(box, "read_file", JSON.stringify({ path: "src/math.ts", lines: 1 }));
    expect(r).toMatchObject({ ok: true, range: [1, 1] });
  });
});

describe("15. the bounds on the work one call may ask for", () => {
  const timed = async (name: string, args: unknown, b: ToolBox = box) => {
    const started = performance.now();
    const r = await runTool(b, name, args);
    return { r, ms: performance.now() - started };
  };

  it("refuses a pattern or glob over 1,000 characters at once", async () => {
    // Under the arguments' own bound (failure 17 covers a 64 KB argument),
    // so the field's limit is what refuses it.
    const big = "a".repeat(2 * 1024);
    for (const [name, args] of [
      ["search_code", { pattern: big }],
      ["search_code", { pattern: "x", glob: big }],
      ["list_files", { glob: big }],
    ] as const) {
      const { r, ms } = await timed(name, args);
      expect(ms, name).toBeLessThan(500);
      expect(r, name).toMatchObject({ ok: false, inside: true });
      expect(r.reason, name).toMatch(/over 1000 characters/);
    }
  });

  it("runs patterns that backtrack without end elsewhere in bounded time", async () => {
    for (const pattern of ["^(x+x+)+y$", "(x*)*(x*)*(x*)*y", "(x|xx|xxx)+y", "(.*){20}y"]) {
      const { r, ms } = await timed("search_code", { pattern });
      expect(ms, pattern).toBeLessThan(5_000);
      expect(r.ok, pattern).toBe(true);
    }
  });

  it("refuses a glob of 100 brace lists at once, as a call it will not run, not an attempt outside", async () => {
    const glob = "{a,b}".repeat(100);
    for (const name of ["list_files", "search_code"]) {
      const { r, ms } = await timed(name, { pattern: "x", glob });
      expect(ms, name).toBeLessThan(500);
      expect(r, name).toMatchObject({ ok: false, inside: true });
      expect(r.reason, name).toMatch(/brace list/);
    }
  });

  it("matches a glob of many ** steps in bounded time", async () => {
    const glob = `${"**a".repeat(150)}**b`;
    const { r, ms } = await timed("list_files", { glob });
    expect(ms).toBeLessThan(5_000);
    expect(r.ok).toBe(true);
  });

  it("stops a listing and a search of 20,000 files at the walk's bound and records the cut", async () => {
    const dir = tempDir("oq-tools-many-");
    for (let f = 0; f < 100; f++) {
      mkdirSync(join(dir, `d${String(f).padStart(3, "0")}`));
      for (let k = 0; k < 200; k++) writeFileSync(join(dir, `d${String(f).padStart(3, "0")}`, `f${k}.txt`), "a line of text\n");
    }
    const many: ToolBox = { ...box, snapshotDir: dir };
    const listed = await timed("list_files", {}, many);
    expect(listed.ms).toBeLessThan(10_000);
    expect(listed.r.ok).toBe(true);
    expect(listed.r.text.split("\n")[0]).toBe(`${WALK_FILES} or more files; the file walk stopped after ${WALK_FILES} files`);
    expect(listed.r.reason).toMatch(new RegExp(`^the file walk stopped after ${WALK_FILES} files; cut at 32 KB: \\d+ of ${WALK_FILES} files listed; narrow the glob$`));
    expect(Buffer.byteLength(listed.r.text)).toBeLessThanOrEqual(TOOL_REPLY_BYTES);
    const searched = await timed("search_code", { pattern: "line" }, many);
    expect(searched.ms).toBeLessThan(15_000);
    expect(searched.r.ok).toBe(true);
    expect(searched.r.text.split("\n")[0]).toMatch(/^500 matches in 10000 or more files; the search stopped at 500 matches$/);
    expect(searched.r.reason).toMatch(/stopped at 500 matches/);
    const none = await timed("search_code", { pattern: "zz_absent" }, many);
    expect(none.ms).toBeLessThan(15_000);
    expect(none.r.text).toBe(`0 matches in ${WALK_FILES} or more files; the file walk stopped after ${WALK_FILES} files`);
    expect(none.r.reason).toBe(`the file walk stopped after ${WALK_FILES} files; narrow the pattern or the glob`);
    // The cap trips only past WALK_FILES (10,000) files, so the fixture keeps
    // its 20,000 files. Writing them is most of this test's time: 87 to 271 s
    // on a loaded Mac against the 30 s default. Each tool call keeps its own
    // limit above; only the room to write the fixture is raised here.
  }, 600_000);

  it("a glob means what core's glob matcher says it means", () => {
    const paths = ["src/a.ts", "src/x/b.ts", "a.ts", "src/.hidden", "docs/a.md"];
    for (const [glob, want] of [
      ["src/*.ts", ["src/a.ts"]],
      ["src/**", ["src/a.ts", "src/x/b.ts", "src/.hidden"]],
      ["**.ts", ["src/a.ts", "src/x/b.ts", "a.ts"]],
      ["?.ts", ["a.ts"]],
      ["docs/a.md", ["docs/a.md"]],
    ] as const) {
      const c = compileGlob(glob);
      expect("program" in c, glob).toBe(true);
      const program = (c as { program: Parameters<typeof matchesLine>[0] }).program;
      expect(paths.filter((p) => matchesLine(program, p)), glob).toEqual(want);
    }
  });
});

describe("the review's folder scopes", () => {
  it("16. refuse a path outside them, filter listings and searches, log inScope, and keep the packet readable", async () => {
    const dir = tempDir("oq-tools-scoped-");
    for (const [path, text] of [
      ["src/a.ts", "export const inside = 1;\n"],
      ["lib/b.ts", "export const outside = 2;\n"],
      [".openqodex-review/graph/index.md", "# The graph files\n"],
    ] as const) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const scoped: ToolBox = { snapshotDir: dir, change, secrets: [], graph: null, graphNote: null, admit: admitted(["src"], []) };
    for (const [tool, args] of [
      ["read_file", { path: "lib/b.ts" }],
      ["read_diff_for_file", { path: "lib/b.ts" }],
      ["find_callers", { symbol: "outside", file: "lib/b.ts" }],
    ] as const) {
      const r = await runTool(scoped, tool, args);
      expect(r, tool).toMatchObject({ ok: false, inside: true, inScope: false, path: "lib/b.ts", reason: "outside the review's scopes", text: "refused: outside the review's scopes" });
    }
    expect(await runTool(scoped, "read_file", { path: "src/a.ts" })).toMatchObject({ ok: true, inScope: true });
    expect(await runTool(scoped, "read_file", { path: ".openqodex-review/graph/index.md" })).toMatchObject({ ok: true, inScope: true });
    const listed = await runTool(scoped, "list_files", {});
    expect(listed).toMatchObject({ ok: true, inScope: true });
    expect(listed.text.split("\n").slice(1).sort()).toEqual([".openqodex-review/graph/index.md", "src/a.ts"]);
    const searched = await runTool(scoped, "search_code", { pattern: "export const" });
    expect(searched).toMatchObject({ ok: true, inScope: true });
    expect(searched.text).toContain("src/a.ts:1:");
    expect(searched.text).not.toContain("lib/b.ts");
    // With no folder scopes the field stays null.
    expect((await runTool({ ...scoped, admit: undefined }, "read_file", { path: "lib/b.ts" })).inScope).toBeNull();
  });
});

describe("the size of a call", () => {
  it("17. refuses arguments over the bound before reading or logging them, and holds every refusal to 32 KB", async () => {
    const huge = "x".repeat(64 * 1024);
    for (const [tool, args] of [
      ["find_callers", { symbol: huge, file: "src/math.ts" }],
      ["read_file", { path: `src/${huge}` }],
      ["search_code", JSON.stringify({ pattern: huge })],
    ] as const) {
      const r = await runTool(box, tool, args);
      expect(r, tool).toMatchObject({ ok: false, reason: `bad arguments: the arguments are over ${TOOL_ARGS_BYTES / 1024} KB, or cannot be written as JSON` });
      expect(r.detail, tool).toBe(`(arguments over ${TOOL_ARGS_BYTES / 1024} KB, not kept)`);
      expect(Buffer.byteLength(r.text), tool).toBeLessThanOrEqual(TOOL_REPLY_BYTES);
    }
    // Under the argument bound, a refusal that echoes the argument stays in bounds too.
    const long = "y".repeat(TOOL_ARGS_BYTES - 100);
    const missing = await runTool(box, "find_callers", { symbol: long, file: "src/math.ts" });
    expect(missing.ok).toBe(false);
    expect(Buffer.byteLength(missing.text)).toBeLessThanOrEqual(TOOL_REPLY_BYTES);
    expect(missing.reason!.length).toBeLessThanOrEqual(2000);
  });
});
