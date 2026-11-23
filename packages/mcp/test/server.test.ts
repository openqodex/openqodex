// `openqodex mcp`, the built CLI's MCP server, driven over stdio by the MCP
// SDK's own client, as an agent drives it. Ways it could fail, written
// before the code:
//  1. A question of the query layer has no tool, or a tool's description
//     does not say that answers are data and that a zero on a floor is not
//     "unused".
//  2. A tool answers differently from `openqodex graph <question> --json`
//     for the same request and the same build (the adapter changes meaning).
//  3. A question naming another repository, a path outside the repository
//     or a build id that is not one is answered instead of refused.
//  4. A token budget cuts the counts, or returns nothing and never moves.
//  5. The held build is removed while the agent still asks about it: a
//     build published meanwhile by another command collects it, or the
//     answers move to the new build without `graph_refresh`; or an edit
//     made since is not said (`laterEditsKnown`).
//  6. A cancelled question breaks the server, so the next one fails.
//  7. The lease stays after the agent disconnects, or the server keeps
//     running.
//  8. A server started outside a repository crashes instead of saying why.
//  9. A first question that compares the work tree with its base leaves no
//     held build, so a later question answers from a tree edited since,
//     without `graph_refresh`.
// 10. Many questions that each need a build start as many builds at once,
//     with no bound on how many wait.
// 11. The next page of a comparison builds the comparison again: a build
//     that is not complete gets a new id, and the server refuses its own
//     cursor.
// 12. A comparison's cursor is accepted for a comparison with another
//     base, and pages a list it was not made from.
// 13. The tool list costs an agent more than it needs: the paragraph on
//     answers repeated in every description, the shared arguments described
//     in every input schema. Or it has no output schema, or a result carries
//     no structuredContent (sent since 0.20.0, so a client reads it), or
//     the structured answer and the text differ, or the text is no longer
//     what `openqodex graph --json` prints.
// 14. Source lines asked with `context` come from the work tree after an
//     edit instead of the held build, say nothing of the edit, or carry a
//     key written in the repository.
// 15. `compact` changes what the answer says, or answers otherwise than
//     `openqodex graph --compact --json`.
// 16. An answer costs an agent many times what grep does for the same
//     rows, mostly the long edge id on every item: the default answer is
//     not short, its short edge id does not explain, an old long id no
//     longer explains, or `full` no longer gives the whole item.
// 17. A name that matches several definitions gives the agent nothing to
//     pick from in the default form.
// 18. A question that compares (`impact` of the change) is answered from
//     the comparison's build, not the held one: a short edge id it gives
//     is kept where `graph_explain` never looks, and explains to nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OPERATIONS } from "@openqodex/graph";
import type { Answer } from "@openqodex/graph";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "dist", "bin.js");
const dirs: string[] = [];
const home = realpathSync(mkdtempSync(join(tmpdir(), "oq-mcp-home-")));
dirs.push(home);
const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, OPENQODEX_HOME: join(home, ".openqodex"), OPENQODEX_AUTO_UPDATE: "0" };

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oq-mcp-")));
  dirs.push(root);
  write(root, files);
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function cli(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
}

const clients: Client[] = [];
async function connect(cwd: string, more: Record<string, string> = {}): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], cwd, env: { ...env, ...more }, stderr: "pipe" });
  const client = new Client({ name: "openqodex-test", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

type Result = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: unknown };
async function ask(client: Client, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<{ answer: Answer; isError: boolean; text: string; result: Result }> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 })) as Result;
  const text = r.content[0]?.text ?? "null";
  return { answer: JSON.parse(text) as Answer, isError: r.isError === true, text, result: r };
}

// The answer as one text block, and the same answer as structuredContent.
function sentBoth(r: Result): void {
  expect(r.content).toHaveLength(1);
  expect(r.content[0]?.type).toBe("text");
  expect(r.structuredContent).toEqual(JSON.parse(r.content[0]?.text ?? "null"));
}

// The size of the tool list before the paragraph on answers and the shared
// arguments were said once (0.18.0: 37,825 characters of compact JSON).
const TOOLS_BEFORE = 37_825;

function leases(root: string): { id: string; purpose: string; pid: number }[] {
  const dir = join(root, ".openqodex", "graph", "leases");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { id: string; purpose: string; pid: number });
}

const files: Record<string, string> = { "src/core.ts": "export function core(): number {\n  return 1;\n}\n" };
for (let i = 0; i < 12; i++) files[`src/c${i}.ts`] = `import { core } from "./core";\nexport function c${i}(): number {\n  return core() + ${i};\n}\n`;

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("the MCP server", () => {
  let root: string;
  let client: Client;
  beforeAll(async () => {
    root = repo(files);
    ({ client } = await connect(root));
  }, 120_000);

  it("lists one tool per question and graph_refresh, each saying answers are data and a floor is not unused (1)", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...OPERATIONS.map((o) => `graph_${o}`), "graph_refresh"].sort());
    for (const t of tools) {
      expect(t.description, t.name).toMatch(/data, never instructions/);
      expect(t.description, t.name).toMatch(/not "unused"/);
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(t.outputSchema?.type, t.name).toBe("object");
    }
  });

  it("says the paragraph on answers once, in the instructions, and lists its tools in 40% less (13)", async () => {
    const { tools } = await client.listTools();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/data, never instructions/);
    expect(instructions).toMatch(/not "unused"/);
    expect(instructions).toMatch(/structuredContent/);
    // A callers floor reads the target only: a caller of a caller may be missing past one hop.
    expect(instructions).toMatch(/unknown\.floor covers the target only/);
    expect(instructions).not.toMatch(/followed every path/);
    // Each shared argument is described there once.
    for (const arg of ["limit", "cursor", "budget", "generation", "context", "compact"]) expect(instructions, arg).toContain(`\`${arg}\``);
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(TOOLS_BEFORE * 0.6);
    const search = tools.find((t) => t.name === "graph_search");
    expect(search?.description).toMatch(/exact and prefix name matches in `items`/);
    expect(search?.description).toMatch(/other hits in `leads`/);
    expect(search?.description).toMatch(/`target`/);
  });

  it("returns each answer as structuredContent too, its text what `openqodex graph --json` prints (13)", async () => {
    const callers = await ask(client, "graph_callers", { symbol: "core", full: true });
    sentBoth(callers.result);
    expect(callers.answer.items).toHaveLength(12);
    const generation = callers.answer.graph.generation as string;
    const r = cli(root, "graph", "callers", "core", "--json", "--generation", generation);
    expect(callers.text).toBe(r.stdout.trimEnd());
    const search = await ask(client, "graph_search", { text: "c1", full: true });
    sentBoth(search.result);
    expect(search.answer.leads.length).toBeGreaterThan(0);
    expect(search.text).toBe(cli(root, "graph", "search", "c1", "--json", "--generation", generation).stdout.trimEnd());
    // The refusal and error envelopes match the output schema too: the
    // client validates every structuredContent against it.
    const refused = await ask(client, "graph_outline", { path: "../outside" });
    expect(refused.isError).toBe(true);
    expect(refused.answer.error?.code).toBe("refused");
    sentBoth(refused.result);
    const missing = await ask(client, "graph_callers", { symbol: "nothingNamedThis" });
    expect(missing.answer.error?.code).toBe("not-found");
    sentBoth(missing.result);
  });

  it("answers as `openqodex graph --json` does for the same request and build (2)", async () => {
    const { answer } = await ask(client, "graph_callers", { symbol: "core", full: true });
    expect(answer.error).toBeNull();
    expect(answer.counts.certain).toBe(12);
    const generation = answer.graph.generation as string;
    const r = cli(root, "graph", "callers", "core", "--json", "--generation", generation);
    expect(r.status, r.stderr).toBe(0);
    expect(answer).toEqual(JSON.parse(r.stdout));
    const path = await ask(client, "graph_path", { from: "c3", to: "core", full: true });
    const p = cli(root, "graph", "path", "c3", "core", "--json", "--generation", generation);
    expect(path.answer).toEqual(JSON.parse(p.stdout));
  });

  it("refuses another repository, a path outside this one and a build id that is not one (3)", async () => {
    const other = repo({ "x.ts": "export const x = 1;\n" });
    for (const [name, args] of [
      ["graph_status", { repo: other }],
      ["graph_callers", { symbol: "core", repo: "/" }],
      ["graph_outline", { path: "../outside" }],
      ["graph_outline", { path: "/etc" }],
      ["graph_callers", { symbol: "../../etc/passwd:1" }],
      ["graph_importers", { file: "src/../../x.ts" }],
      ["graph_callers", { symbol: "core", generation: "../../../etc" }],
    ] as const) {
      const { answer, isError } = await ask(client, name, args);
      expect(isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(answer.error?.code, `${name} ${JSON.stringify(args)}`).toBe("refused");
    }
    // The server's own repository by its path is answered.
    const own = await ask(client, "graph_status", { repo: root });
    expect(own.answer.error).toBeNull();
  });

  it("cuts by a token budget without touching the counts, and pages on (4)", async () => {
    const { answer } = await ask(client, "graph_callers", { symbol: "core", budget: { tokens: 1 }, full: true });
    expect(answer.items).toHaveLength(1);
    expect(answer.counts.certain).toBe(12);
    expect(answer.truncated).toMatchObject({ by: "budget", omitted: 11, omittedExact: true });
    const next = await ask(client, "graph_callers", { symbol: "core", budget: { tokens: 1 }, cursor: answer.truncated.cursor, full: true });
    expect(next.answer.items).toHaveLength(1);
    expect(next.answer.items[0]).not.toEqual(answer.items[0]);
  });

  it("keeps a cancelled question from breaking the next one (6)", async () => {
    const abort = new AbortController();
    const pending = ask(client, "graph_cycles", {}, abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow();
    const { answer } = await ask(client, "graph_status");
    expect(answer.error).toBeNull();
  });
});

describe("an answer's shape", () => {
  const shaped = {
    "src/core.ts": "export function core(): number {\n  return 1;\n}\n",
    "src/use.ts": 'import { core } from "./core";\nexport function use(): number {\n  const key = "ghp_abcdefghijklmnopqrstuvwx1234";\n  return core();\n}\n',
  };
  type WithContext = Answer & { context?: { around: number; note: string; snippets: { file: string; line: number; start: number; lines: string[]; from: string | null; changedSince: boolean | null }[] } };

  it("adds the held build's lines around each site, redacted, and says when the work tree differs (14)", async () => {
    const root = repo(shaped);
    const { client } = await connect(root);
    const first = await ask(client, "graph_callers", { symbol: "core", context: 1, full: true });
    const a = first.answer as WithContext;
    const use = a.context?.snippets.find((x) => x.file === "src/use.ts");
    expect(use).toMatchObject({ line: 4, start: 3, from: "build", changedSince: false });
    expect(use?.lines[1]).toBe("  return core();");
    expect(first.text).not.toContain("ghp_abcdefghijklmnopqrstuvwx1234");
    const generation = a.graph.generation as string;
    expect(a).toEqual(JSON.parse(cli(root, "graph", "callers", "core", "--json", "--context", "1", "--generation", generation).stdout));
    // An edit after the build moves the call down a line; the answer still
    // gives the build's line 4 and the build's lines around it.
    write(root, { "src/use.ts": `// a new first line\n${shaped["src/use.ts"]}` });
    await new Promise((r) => setTimeout(r, 1100));
    const later = (await ask(client, "graph_callers", { symbol: "core", context: 1, full: true })).answer as WithContext;
    expect(later.graph.generation).toBe(generation);
    expect(later.graph.freshness.laterEditsKnown).toBe(true);
    const moved = later.context?.snippets.find((x) => x.file === "src/use.ts");
    expect(moved?.lines).toEqual(use?.lines);
    expect(moved).toMatchObject({ from: "build", changedSince: true });
  }, 180_000);

  it("drops edge ids and import lines with `compact`, as the command line does (15)", async () => {
    const root = repo(files);
    const { client } = await connect(root);
    const full = await ask(client, "graph_callers", { symbol: "core", full: true });
    const compact = await ask(client, "graph_callers", { symbol: "core", compact: true, full: true });
    expect(compact.answer.counts).toEqual(full.answer.counts);
    expect(compact.answer.items).toHaveLength(full.answer.items.length);
    for (const i of compact.answer.items as Record<string, unknown>[]) expect(i).not.toHaveProperty("edge");
    expect(compact.text.length).toBeLessThan(full.text.length * 0.8);
    const generation = full.answer.graph.generation as string;
    expect(compact.answer).toEqual(JSON.parse(cli(root, "graph", "callers", "core", "--json", "--compact", "--generation", generation).stdout));
  }, 180_000);
});

describe("the short form, the default over MCP", () => {
  type Edge = Record<string, unknown> & { edge: string; site: Record<string, unknown> };

  it("gives short edge ids that explain, keeps old long ids working, and gives the whole item with `full` (16)", async () => {
    const root = repo(files);
    const { client } = await connect(root);
    const full = await ask(client, "graph_callers", { symbol: "core", full: true });
    const short = await ask(client, "graph_callers", { symbol: "core" });
    sentBoth(short.result);
    expect(short.answer.counts).toEqual(full.answer.counts);
    expect(short.answer.unknown).toEqual(full.answer.unknown);
    expect(short.answer.target).toEqual(full.answer.target);
    const items = short.answer.items as Edge[];
    const whole = full.answer.items as Edge[];
    expect(items).toHaveLength(whole.length);
    items.forEach((i, n) => {
      const w = whole[n] as Edge;
      expect(i.edge).toMatch(/^e:[A-Za-z0-9_-]{12}$/);
      // The target end and the column, rule and import line are left out;
      // file, line, tier, evidence and the caller stay.
      expect(i).not.toHaveProperty("to");
      expect(i).not.toHaveProperty("toName");
      expect(i.site).not.toHaveProperty("column");
      expect(i.site).not.toHaveProperty("via");
      expect(i.site).toMatchObject({ file: w.site.file, line: w.site.line, tier: w.site.tier, evidence: w.site.evidence });
      expect(i.from).toBe(w.from);
    });
    expect(short.text.length).toBeLessThan(full.text.length * 0.6);
    // The same edge gets the same short id on every ask.
    const again = await ask(client, "graph_callers", { symbol: "core" });
    expect((again.answer.items as Edge[]).map((i) => i.edge)).toEqual(items.map((i) => i.edge));
    // A short id explains the edge its long id names; the long id still does.
    const first = items[0] as Edge;
    const byShort = await ask(client, "graph_explain", { edge: first.edge });
    expect(byShort.answer.error).toBeNull();
    const byLong = await ask(client, "graph_explain", { edge: (whole[0] as Edge).edge });
    expect(byLong.answer.error).toBeNull();
    expect(byShort.answer.items).toEqual(byLong.answer.items);
    expect((byShort.answer.items[0] as Edge).site).toEqual((whole[0] as Edge).site);
    // A short id this build never gave is not found, never a guess.
    const unknown = await ask(client, "graph_explain", { edge: "e:AAAAAAAAAAAA" });
    expect(unknown.answer.error?.code).toBe("not-found");
    // compact false asks the whole item too.
    expect((await ask(client, "graph_callers", { symbol: "core", compact: false })).answer).toEqual(full.answer);
  }, 180_000);

  it("gives edge ids that all explain in the answer of a question that compares (18)", async () => {
    const root = repo(files);
    write(root, { "src/core.ts": "export function core(): number {\n  return 2;\n}\n" });
    const { client } = await connect(root);
    const a = await ask(client, "graph_impact", {});
    expect(a.answer.error).toBeNull();
    const edges: string[] = [];
    const collect = (v: unknown) => {
      if (typeof v !== "object" || v === null) return;
      const r = v as Record<string, unknown>;
      if (typeof r.edge === "string") edges.push(r.edge);
      for (const key of ["hops", "handles"]) if (Array.isArray(r[key])) (r[key] as unknown[]).forEach(collect);
    };
    a.answer.items.forEach(collect);
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      const why = await ask(client, "graph_explain", { edge });
      expect(why.answer.error, edge).toBeNull();
    }
    // The rest of the short form still holds: no column or import line.
    const hop = (a.answer.items as { hops?: Edge[] }[]).flatMap((i) => i.hops ?? [])[0] as Edge;
    expect(hop.site).not.toHaveProperty("column");
  }, 180_000);

  it("gives the candidates of an ambiguous name, to pick one by id (17)", async () => {
    const root = repo({
      "a.ts": "export function run(): number {\n  return 1;\n}\n",
      "b.ts": "export function run(): number {\n  return 2;\n}\n",
      "c.ts": 'import { run } from "./a";\nexport function go(): number {\n  return run();\n}\n',
    });
    const { client } = await connect(root);
    const a = await ask(client, "graph_callers", { symbol: "run" });
    expect(a.isError).toBe(false);
    expect(a.answer.error?.code).toBe("ambiguous");
    const picks = a.answer.target as { id: string; name: string; kind: string; file: string; line: number }[];
    expect(picks.map((c) => `${c.name} ${c.kind} ${c.file}:${c.line}`).sort()).toEqual(["run function a.ts:1", "run function b.ts:1"]);
    const chosen = picks.find((c) => c.file === "a.ts") as { id: string };
    const one = await ask(client, "graph_callers", { id: chosen.id });
    expect(one.answer.error).toBeNull();
    expect((one.answer.items as Edge[]).map((i) => `${i.site.file}:${i.site.line}`)).toEqual(["c.ts:3"]);
  }, 180_000);
});

describe("the held build", () => {
  it("stays readable and answering while other builds publish, says the edit, and moves only on refresh (5, 7)", async () => {
    const root = repo(files);
    const { client, transport } = await connect(root);
    const first = await ask(client, "graph_callers", { symbol: "core" });
    const held = first.answer.graph.generation as string;
    expect(held).toMatch(/^[0-9a-z]{13}-/);
    expect(first.answer.graph.freshness.laterEditsKnown).toBe(false);
    expect(leases(root).filter((l) => l.purpose === "mcp").map((l) => l.id)).toEqual([held]);
    // Three builds published by the command line, each of an edited tree:
    // without the lease the collector would remove the held one.
    for (let i = 0; i < 3; i++) {
      write(root, { [`src/extra${i}.ts`]: `import { core } from "./core";\nexport function extra${i}(): number {\n  return core();\n}\n` });
      const b = cli(root, "graph", "build");
      expect(b.status, b.stderr).toBe(0);
    }
    expect(existsSync(join(root, ".openqodex", "graph", "generations", held))).toBe(true);
    // The server looks for edits at most once a second; three quick builds
    // can take less.
    await new Promise((r) => setTimeout(r, 1100));
    const later = await ask(client, "graph_callers", { symbol: "core" });
    expect(later.answer.graph.generation).toBe(held);
    expect(later.answer.counts.certain).toBe(12);
    expect(later.answer.graph.freshness.laterEditsKnown).toBe(true);
    const refreshed = await ask(client, "graph_refresh");
    const moved = refreshed.answer.graph.generation as string;
    expect(moved).not.toBe(held);
    expect(refreshed.answer.graph.freshness.laterEditsKnown).toBe(false);
    const after = await ask(client, "graph_callers", { symbol: "core" });
    expect(after.answer.graph.generation).toBe(moved);
    expect(after.answer.counts.certain).toBe(15);
    expect(leases(root).filter((l) => l.purpose === "mcp").map((l) => l.id)).toEqual([moved]);
    // Disconnect: the server exits and its lease goes (7).
    const pid = transport.pid;
    await client.close();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && leases(root).some((l) => l.purpose === "mcp")) await new Promise((r) => setTimeout(r, 50));
    expect(leases(root).filter((l) => l.purpose === "mcp")).toEqual([]);
    let alive = true;
    while (Date.now() < deadline && alive) {
      try {
        process.kill(pid as number, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 180_000);

  it("says why when started outside a repository, and keeps serving (8)", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "oq-mcp-nogit-")));
    dirs.push(outside);
    // git looks no higher than the folder's parent: the temporary folder
    // may itself sit inside a repository.
    const { client } = await connect(outside, { GIT_CEILING_DIRECTORIES: dirname(outside) });
    const { answer, isError } = await ask(client, "graph_status");
    expect(isError).toBe(true);
    expect(answer.error?.code).toBe("refused");
    expect(answer.error?.message).toMatch(/not inside a git repository/);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });
});

describe("the builds a server starts", () => {
  const edited = "export function core(): number {\n  return 2;\n}\n";

  it("holds the build of a first question that compares, so a later edit needs graph_refresh (9)", async () => {
    const root = repo(files);
    write(root, { "src/core.ts": edited });
    const { client } = await connect(root);
    const first = await ask(client, "graph_changes", {});
    expect(first.answer.error).toBeNull();
    // Two leases: the session's build, and the comparison kept for its
    // cursors (one build of the same capture may serve both).
    const held = leases(root).filter((l) => l.purpose === "mcp").map((l) => l.id);
    expect(held).toHaveLength(2);
    write(root, { "src/late.ts": 'import { core } from "./core";\nexport function late(): number {\n  return core();\n}\n' });
    const later = await ask(client, "graph_callers", { symbol: "core" });
    expect(held).toContain(later.answer.graph.generation);
    expect(later.answer.counts.certain).toBe(12);
  }, 180_000);

  it("runs builds one at a time with a few waiting, and refuses the rest as busy (10)", async () => {
    const root = repo(files);
    write(root, { "src/core.ts": edited });
    const { client } = await connect(root);
    const asked = await Promise.all(Array.from({ length: 12 }, () => ask(client, "graph_changes", {})));
    const codes = asked.map((a) => a.answer.error?.code ?? "ok");
    expect(codes.every((c) => c === "ok" || c === "busy"), codes.join(" ")).toBe(true);
    expect(codes.filter((c) => c === "busy").length, codes.join(" ")).toBeGreaterThan(0);
    const ok = asked.filter((a) => a.answer.error === null);
    expect(ok.length).toBeGreaterThan(0);
    for (const a of ok) expect(a.answer.items).toEqual(ok[0]?.answer.items);
    // The server goes on answering.
    const { answer } = await ask(client, "graph_status");
    expect(answer.error).toBeNull();
  }, 180_000);
});

describe("a comparison's cursor", () => {
  const exports = (names: string[]) => names.map((n) => `export function ${n}(): number {\n  return 1;\n}\n`).join("");
  const gitIn = (root: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();

  it("pages the comparison it was made on, even from a build that is not complete (11)", async () => {
    // A tsconfig that does not parse can hide an import: no build of this
    // repository is complete, so each one is saved under its own id.
    const root = repo({ ...files, "tsconfig.json": '{ "compilerOptions": ', "src/core.ts": exports(["core", "alpha", "beta", "gamma"]) });
    write(root, { "src/core.ts": exports(["core"]) });
    const { client } = await connect(root);
    const first = await ask(client, "graph_changes", { limit: 1 });
    expect(first.answer.error).toBeNull();
    expect(first.answer.graph.status).toBe("partial");
    expect(first.answer.truncated.cursor).not.toBeNull();
    const second = await ask(client, "graph_changes", { limit: 1, cursor: first.answer.truncated.cursor });
    expect(second.answer.error).toBeNull();
    expect(second.answer.graph.generation).toBe(first.answer.graph.generation);
    expect(second.answer.items).toHaveLength(1);
    expect(second.answer.items).not.toEqual(first.answer.items);
  }, 180_000);

  it("is refused for a comparison with another base (12)", async () => {
    const root = repo({ ...files, "src/core.ts": exports(["core", "alpha", "beta", "gamma"]) });
    const base1 = gitIn(root, "rev-parse", "HEAD");
    write(root, { "src/core.ts": exports(["core", "alpha", "beta"]) });
    gitIn(root, "commit", "-qam", "drop gamma");
    const base2 = gitIn(root, "rev-parse", "HEAD");
    write(root, { "src/core.ts": exports(["core"]) });
    const { client } = await connect(root);
    const first = await ask(client, "graph_changes", { base: base1, limit: 1 });
    expect(first.answer.error).toBeNull();
    expect(first.answer.truncated.cursor).not.toBeNull();
    const other = await ask(client, "graph_changes", { base: base2, limit: 1, cursor: first.answer.truncated.cursor });
    expect(other.isError).toBe(true);
    expect(other.answer.error?.code).toBe("generation-unavailable");
    // The same base pages on.
    const same = await ask(client, "graph_changes", { base: base1, limit: 1, cursor: first.answer.truncated.cursor });
    expect(same.answer.error).toBeNull();
    expect(same.answer.items).not.toEqual(first.answer.items);
  }, 180_000);
});
