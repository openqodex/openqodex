// The library entry, tested the way a program gets it: the package is packed
// into a tarball, installed into a fresh project with no network, and used
// from there. Build first (`pnpm build`).
//
// Ways the library entry could fail, written before the code:
// 1. The package has no library entry, so `import("openqodex")` does not
//    resolve, or it loads the command instead.
// 2. Importing it starts the command, prints, or keeps the process alive
//    (an update check, a timer, a child process).
// 3. Importing it writes an environment variable or adds a process listener
//    (a signal handler), which changes the host program it runs in.
// 4. A name the library promises is missing at run time.
// 5. The declarations are missing, import a private @openqodex package or
//    any other package the tarball does not install, or type an export as
//    `any`, so a typed program does not compile or is not checked.
// 6. A program that bundles its own code with openqodex left external finds
//    no lenses, no toolchain table or no grammars, because the library looks
//    for its files from the wrong folder or from the current folder.
// 7. The toolchain table read through the library lacks a tool's version or
//    checksum, or its hash leaves out the lock files.
// 8. A renderer throws on a report, or writes SARIF that is not 2.1.0.
// 9. A bundled program with openqodex external cannot run one review with
//    a model reviewer: reviewChange is missing, or a file it needs (lenses,
//    toolchain table, grammars) is looked for beside the bundle.
// 10. A host's code scan cannot tell a security lens from the others: the
//     `security: true` of a lens file is not on the lens it loads.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Report } from "@openqodex/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = dirname(here);
const repoRoot = dirname(dirname(cliRoot));
const require = createRequire(import.meta.url);

// Every value the library exports: the functions by name and the four
// namespaces that group them.
const VALUES = [
  "buildGraph",
  "createToolResolver",
  "defaultLensDir",
  "detectImpact",
  "extractFacts",
  "graph",
  "isFixturePath",
  "lenses",
  "loadConfig",
  "loadLensCatalog",
  "loadToolchain",
  "PacketCollision",
  "PacketLeak",
  "parseConfig",
  "preinstallScanners",
  "render",
  "renderJson",
  "renderMarkdown",
  "renderReview",
  "renderSarif",
  "reviewChange",
  "reviewerContract",
  "ruleClassFor",
  "runScanners",
  "scanners",
  "selectLenses",
  "selectLensesForDiff",
  "toolchainHash",
  "writePacket",
].sort();

// Every type the library exports: the finding, report and completion types,
// and the types the exported functions take and return.
const TYPES = [
  "BuildArgs",
  "Candidate",
  "Category",
  "Change",
  "ChangedFile",
  "CompletionRecord",
  "Config",
  "DiffCoverage",
  "FileFacts",
  "Graph",
  "ImpactSummary",
  "Lang",
  "Lens",
  "LoadedConfig",
  "ParseOptions",
  "PreinstallOptions",
  "PreinstallResult",
  "PreinstallTool",
  "Recipe",
  "Report",
  "ReportFinding",
  "ResolveTool",
  "ReviewerRecord",
  "RunScannersResult",
  "ScannerRunSummary",
  "ScannerSource",
  "ScanResult",
  "SelectedLens",
  "Severity",
  "StaticFinding",
  "Toolchain",
  "ToolResolution",
  "Verdict",
  "Reviewer",
  "AgentReviewer",
  "ModelReviewer",
  "ModelRequest",
  "ModelResponse",
  "ModelUsage",
  "Message",
  "ToolCallRequest",
  "ToolDefinition",
  "ToolParameter",
  "Budget",
  "AuthorizeRequest",
  "ReviewChangeInput",
  "ReviewChangeOptions",
  "ReviewResult",
  "ReviewScope",
  "ReviewStatus",
  "ResultFinding",
  "Disposition",
  "CallRecord",
  "UsageTotals",
  "ModelPurpose",
  "ReviewerRole",
  "ToolLogEntry",
  "ModelReviewEvidence",
  "ContextItem",
  "ContextKind",
  "Disagreement",
];

// What each namespace holds: the same functions as the named exports.
const NAMESPACES: Record<string, string[]> = {
  scanners: ["createToolResolver", "isFixturePath", "loadToolchain", "preinstallScanners", "ruleClassFor", "runScanners", "toolchainHash"],
  graph: ["buildGraph", "detectImpact", "extractFacts", "PacketCollision", "PacketLeak", "writePacket"],
  lenses: ["defaultLensDir", "loadLensCatalog", "selectLenses", "selectLensesForDiff"],
  render: ["renderJson", "renderMarkdown", "renderReview", "renderSarif"],
};

// One scanner finding on a changed line: enough for every renderer to have
// something to write.
const REPORT: Report = {
  version: 1,
  kind: "scan",
  change_id: "0123456789ab",
  base: { ref: "main", sha: "0".repeat(40) },
  generated_at: "2026-10-09T00:00:00.000Z",
  verdict: "passed",
  block_on_severity: null,
  summary: null,
  findings: [
    {
      origin: "scanner",
      severity: "major",
      category: "security",
      confidence: null,
      file_path: "app/search.py",
      line_number: 14,
      line_end: 14,
      title: "SQL query built from request input",
      description: "The query string is formatted from a request parameter.",
      suggested_change: null,
      source: "semgrep:python.lang.security.audit.formatted-sql-query",
      candidate: null,
      notes: [],
    },
  ],
  below_threshold: 0,
  outside_change: [],
  low_confidence: [],
  not_reviewed: [],
  dropped: [],
  scanners: [{ scanner: "semgrep", status: "ran", version: "1.94.0", rawCount: 1, keptCount: 1, durationMs: 1200, reason: null }],
  impact: null,
  not_reviewed_paths: [],
  stats: { files: 1, additions: 3, deletions: 0 },
};

// A program built the way a server program that bundles its own code builds
// one: its code bundled by esbuild, openqodex left external so it loads from
// node_modules. Each load reports on its own, so one failure does not hide
// the others.
const WORKER = `import { readFileSync } from "node:fs";
import { graph, lenses, render, scanners } from "openqodex";

type Part = { ok: true; value: unknown } | { ok: false; error: string };
async function part(load: () => unknown): Promise<Part> {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const report = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const snippet = "export function add(a: number, b: number): number {\\n  return a + b;\\n}\\nadd(1, 2);\\n";
const out = {
  lenses: await part(() => lenses.loadLensCatalog().length),
  securityLenses: await part(() => lenses.loadLensCatalog().filter((l) => l.security === true).map((l) => l.name).sort()),
  toolchain: await part(() => ({ table: scanners.loadToolchain(), hash: scanners.toolchainHash() })),
  grammars: await part(async () => {
    const facts = await graph.extractFacts("typescript", snippet);
    return facts === null ? null : { defs: facts.defs.map((d) => d.name), calls: facts.calls.map((c) => c.name) };
  }),
  render: await part(() => ({ markdown: render.renderMarkdown(report), sarif: render.renderSarif(report) })),
};
process.stdout.write(JSON.stringify(out));
`;

type Part = { ok: true; value: unknown } | { ok: false; error: string };
type WorkerOut = { lenses: Part; securityLenses: Part; toolchain: Part; grammars: Part; render: Part };

let project = "";
let installed = "";

beforeAll(() => {
  const packDir = tempDir("oq-lib-pack-");
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], { cwd: cliRoot, encoding: "utf8", stdio: "pipe" });
  const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (tgz === undefined) throw new Error(`pnpm pack wrote no tarball into ${packDir}`);
  project = tempDir("oq-lib-project-");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", join(packDir, tgz)], { cwd: project, encoding: "utf8", stdio: "pipe" });
  installed = join(project, "node_modules", "openqodex");
  // pnpm pack and npm install take longer than the default limit on a CI runner.
}, 180_000);

describe("the installed package as a library", () => {
  it("importing it prints nothing and exits at once (no command starts, no update check)", () => {
    const r = spawnSync(process.execPath, ["-e", 'import("openqodex")'], { cwd: project, encoding: "utf8", timeout: 5000 });
    expect(r.signal, "the import was still running after 5 seconds").toBeNull();
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });

  it("importing it writes no environment variable, adds no process listener and exports every promised name", () => {
    const script = `
      const events = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit", "beforeExit", "uncaughtException", "unhandledRejection", "warning", "message"];
      const snap = () => ({ env: { ...process.env }, listeners: Object.fromEntries(events.map((e) => [e, process.listenerCount(e)])) });
      const before = snap();
      const lib = await import("openqodex");
      const after = snap();
      const namespaces = Object.fromEntries(["scanners", "graph", "lenses", "render"].map((n) => [n, Object.keys(lib[n] ?? {}).sort()]));
      const same = Object.fromEntries(Object.entries(namespaces).flatMap(([n, keys]) => keys.map((k) => [n + "." + k, lib[n][k] === lib[k]])));
      process.stdout.write(JSON.stringify({ before, after, names: Object.keys(lib).sort(), namespaces, same }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: project, encoding: "utf8", timeout: 10_000 });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      before: unknown;
      after: unknown;
      names: string[];
      namespaces: Record<string, string[]>;
      same: Record<string, boolean>;
    };
    expect(out.after, "the import changed process.env or added a process listener").toEqual(out.before);
    expect(out.names).toEqual(VALUES);
    for (const [name, keys] of Object.entries(NAMESPACES)) expect(out.namespaces[name], `namespace ${name}`).toEqual([...keys].sort());
    for (const [key, same] of Object.entries(out.same)) expect(same, `${key} is not the same function as the named export`).toBe(true);
  });

  it("a typed program importing every export compiles against the installed declarations, with no `any` and no missing package", () => {
    const declarations = join(installed, "dist", "lib.d.ts");
    expect(existsSync(declarations), "dist/lib.d.ts is not in the package").toBe(true);
    const text = readFileSync(declarations, "utf8");
    const modules = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(modules.filter((m) => !m.startsWith("node:")), "the declarations import a package the tarball does not install").toEqual([]);

    const values = VALUES.join(", ");
    const types = TYPES.map((t) => `type ${t}`).join(", ");
    const lines = [
      `import { ${values}, ${types} } from "openqodex"; import * as lib from "openqodex";`,
      `export const all = [${values}] as const; export type All = [${TYPES.join(", ")}]; type AnyNames<T> = { [K in keyof T]: 0 extends 1 & T[K] ? K : never }[keyof T]; export const noAny: [AnyNames<typeof lib>] extends [never] ? true : AnyNames<typeof lib> = true;`,
    ];
    const consumer = join(project, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "index.ts"), `${lines.join("\n")}\n`);
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          // The declarations themselves are checked: an import they cannot
          // resolve is an error, not a silent `any`.
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(repoRoot, "node_modules", "@types")],
        },
        include: ["consumer/index.ts"],
      }),
    );
    const tsc = require.resolve("typescript/bin/tsc");
    const r = spawnSync(process.execPath, [tsc, "-p", join(project, "tsconfig.json")], { cwd: project, encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`).toBe("");
    expect(r.status).toBe(0);
  }, 60_000);
});

describe("a bundled program with openqodex external", () => {
  let out: WorkerOut;

  beforeAll(async () => {
    const tsup = dirname(require.resolve("tsup/package.json"));
    const esbuild = createRequire(join(tsup, "package.json"))("esbuild") as { build: (options: Record<string, unknown>) => Promise<unknown> };
    const source = join(project, "worker.ts");
    writeFileSync(source, WORKER);
    const bundle = join(project, "dist", "worker.mjs");
    await esbuild.build({
      entryPoints: [source],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: bundle,
      external: ["openqodex"],
      logLevel: "silent",
    });
    const reportFile = join(project, "report.json");
    writeFileSync(reportFile, JSON.stringify(REPORT));
    // Run from a folder that holds nothing, so a lookup from the current
    // folder finds nothing.
    const elsewhere = tempDir("oq-lib-elsewhere-");
    const r = spawnSync(process.execPath, [bundle, reportFile], { cwd: elsewhere, encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error(`the bundled program exited ${r.status}: ${r.stderr}`);
    out = JSON.parse(r.stdout) as WorkerOut;
  }, 120_000);

  it("loads the 48 lenses from the installed package", () => {
    expect(out.lenses, "lenses").toEqual({ ok: true, value: 48 });
  });

  it("tells the security lenses apart: each lens file marked security: true, and no other", () => {
    const folder = join(installed, "lenses");
    const marked = readdirSync(folder)
      .filter((f) => f.endsWith(".md") && /^security: true$/m.test(readFileSync(join(folder, f), "utf8").split("\n---\n")[0]!))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    expect(marked.length).toBeGreaterThan(0);
    expect(out.securityLenses, "security lenses").toEqual({ ok: true, value: marked });
  });

  it("reads the toolchain table: every tool has a version and a checksum, and the hash covers the lock files", () => {
    expect(out.toolchain.ok, `toolchain: ${out.toolchain.ok ? "" : out.toolchain.error}`).toBe(true);
    const { table, hash } = (out.toolchain as { value: { table: { tools: Record<string, Record<string, unknown>> }; hash: string } }).value;
    const tools = Object.entries(table.tools);
    expect(tools.length).toBeGreaterThan(0);
    const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
    for (const [tool, recipe] of tools) {
      expect(recipe.version, `${tool} has no version`).toMatch(/^\d+\.\d+/);
      if (recipe.method === "github-release") {
        const assets = Object.values(recipe.assets as Record<string, { sha256: string } | null>).filter((a) => a !== null);
        expect(assets.length, `${tool} has no release asset`).toBeGreaterThan(0);
        for (const asset of assets) expect(asset.sha256, `${tool} has an asset with no sha256`).toMatch(/^[0-9a-f]{64}$/);
      } else {
        // A registry install is pinned by its hash-locked lock file, one per platform.
        for (const platform of platforms) {
          const lock = join(installed, "locks", `${tool}-${platform}.txt`);
          expect(existsSync(lock), `${tool} has no lock file for ${platform}`).toBe(true);
          expect(readFileSync(lock, "utf8"), `${tool}'s lock for ${platform} pins no sha256`).toMatch(/sha256/);
        }
      }
    }
    // The hash is the table and every lock file as shipped.
    const expected = createHash("sha256").update(readFileSync(join(installed, "toolchain.json")));
    for (const name of readdirSync(join(installed, "locks")).filter((f) => f.endsWith(".txt")).sort()) {
      expected.update(`\0${name}\0`).update(readFileSync(join(installed, "locks", name)));
    }
    expect(hash, "the toolchain hash is not the hash of the shipped table and lock files").toBe(expected.digest("hex"));
  });

  it("starts the tree-sitter grammars and extracts facts from a TypeScript snippet", () => {
    expect(out.grammars, "grammars").toEqual({ ok: true, value: { defs: ["add"], calls: ["add"] } });
  });

  it("renders a report to markdown and to SARIF 2.1.0", () => {
    expect(out.render.ok, `render: ${out.render.ok ? "" : out.render.error}`).toBe(true);
    const { markdown, sarif } = (out.render as { value: { markdown: string; sarif: string } }).value;
    expect(markdown).toContain("SQL query built from request input");
    const parsed = JSON.parse(sarif) as { version: string; runs: { results: unknown[] }[] };
    expect(parsed.version).toBe("2.1.0");
    expect(parsed.runs.flatMap((run) => run.results)).toHaveLength(1);
  });
});

// A server worker as the product would bundle one: reviewChange with a
// model reviewer that answers from a fixed submission (it raises nothing
// and reads the change id from the brief), a budget that allows every call,
// an install root with no scanner in it, and a work folder of its own.
const REVIEW_WORKER = `import { reviewChange } from "openqodex";
const [clonePath, mergeBaseSha, headSha, workDir, installRoot] = process.argv.slice(2);
const reviewer = {
  kind: "model",
  model: "fixture-model",
  maxOutputTokens: 4096,
  async complete(request) {
    const text = request.messages.map((m) => ("text" in m ? m.text : "")).join("\\n");
    const id = /change_id\\W+([0-9a-f]{6,})/.exec(text)?.[1] ?? "";
    const answer = { version: 2, change_id: id, summary: "Reviewed the fixture change.", findings: [], dropped: [] };
    return { message: { text: JSON.stringify(answer), toolCalls: [] }, usage: { model: "fixture-model", inputTokens: 100, outputTokens: 20, costUsd: null } };
  },
};
const budget = { authorize: async () => true, deadlineMs: 120000 };
const result = await reviewChange(
  { clonePath, mergeBaseSha, headSha },
  reviewer,
  { profile: "server", workDir, installRoot, budget, tools: { web: false, shell: false }, scanners: "preinstalled" },
);
process.stdout.write(JSON.stringify({ status: result.status, reason: result.reason ?? null, contract: result.completion?.contract ?? null, calls: result.usage.calls.length }));
`;

describe("a bundled server worker with openqodex external", () => {
  it("runs one review with a model reviewer and gets a complete review with a model completion record", async () => {
    const tsup = dirname(require.resolve("tsup/package.json"));
    const esbuild = createRequire(join(tsup, "package.json"))("esbuild") as { build: (options: Record<string, unknown>) => Promise<unknown> };
    const source = join(project, "review-worker.mjs");
    writeFileSync(source, REVIEW_WORKER);
    const bundle = join(project, "dist", "review-worker.mjs");
    await esbuild.build({ entryPoints: [source], bundle: true, platform: "node", format: "esm", target: "node22", outfile: bundle, external: ["openqodex"], logLevel: "silent" });

    // The host's clone: a base commit and a head commit with a small change.
    const clone = tempDir("oq-lib-review-clone-");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], {
        cwd: clone,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      }).trim();
    git("init", "-q");
    writeFileSync(join(clone, "add.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(clone, "add.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function double(a: number): number {\n  return add(a, a);\n}\n");
    git("commit", "-qam", "head");
    const head = git("rev-parse", "HEAD");

    const workDir = tempDir("oq-lib-review-work-");
    const installRoot = tempDir("oq-lib-review-tools-");
    const r = spawnSync(process.execPath, [bundle, clone, base, head, workDir, installRoot], { cwd: tempDir("oq-lib-review-elsewhere-"), encoding: "utf8", timeout: 120_000 });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { status: string; reason: string | null; contract: string | null; calls: number };
    expect(out.status, out.reason ?? "").toBe("complete");
    expect(out.contract).toBe("openqodex-model-review-1");
    expect(out.calls).toBeGreaterThan(0);
  }, 180_000);
});
