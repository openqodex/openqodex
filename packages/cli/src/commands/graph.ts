// `openqodex graph <question>`: the code graph's answers on the command
// line. A thin adapter over the graph package's one query function, the
// same one the review packet and the MCP server answer with: this file
// parses flags into a request and prints the answer, nothing more.
//
// Each run captures the work tree (or opens `--generation <id>` and never
// builds), builds or reuses the graph in .openqodex/graph/, holds the
// build with a lease while it answers, and prints one fact per line, or the
// Answer as JSON with --json. Exit 0 for any answer, a floor, a partial
// graph or an ambiguous name included; 2 when the question could not be
// answered (not found, a capability this build lacks, a bad request) or
// the build failed.
import { display, findRepoRoot, loadConfig, OpenQodexError } from "@openqodex/core";
import { laterEdits, openStore, OPERATIONS, parseTarget, pinGeneration, pinWorkTree, query, shapeAnswer, unreadNote } from "@openqodex/graph";
import { openqodexHome } from "@openqodex/scanners";
import type { Answer, GraphStore, Item, Operation, Pinned, Request, Shaped } from "@openqodex/graph";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { parseFlags } from "../flags.js";

export const USAGE = [
  "usage: openqodex graph <question> [<target>] [options]",
  "  build [--full]                   build or update .openqodex/graph/ for the work tree",
  "  status | capabilities",
  "  search <text>",
  "  symbol | callers | callees <name | file:line> [--file <path>] [--depth 1..3] [--tier certain,likely]",
  "  callees <name | file:line> --edges calls,defines   also into the definitions it holds",
  "  implementers <class | interface | Class.method> [--depth 1..8]",
  "  references <name | file:line>     uses as a value or a type",
  "  routes [<handler>] [--text <path part>] [--exclude-tests]",
  "  tests <name | file:line>",
  "  path <from> <to> [--edges calls,inherits,defines,imports] [--depth 1..8]",
  "  impact [<name | file:line>]        with no symbol: what the change reaches",
  "  importers <file>",
  "  outline <file | folder>",
  "  packages [--project <folder>]",
  "  cycles [--level files | projects]",
  "  changes [--base <ref>]            public names, removed and moved symbols of the change",
  "  unknowns [--file <path> | --name <name>]",
  "  explain <edge id>",
  "  options: --json, --limit <n>, --cursor <c>, --tokens <n>, --budget-ms <ms>, --generation <build id>, --cwd <dir>",
  "           --context <0..10> (source lines around each place), --compact (with --json: items without edge ids)",
].join("\n");

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

// One line of an answer. Text from the repository (a file name, a symbol, a
// note that quotes either) may hold a line break or a control character, so
// every line of an answer goes through core's display(): each run of
// whitespace becomes one space and control characters are dropped, so no
// part of a name can start a line of its own or reach the terminal as a
// command. The indent is ours and is kept.
function line(text = ""): void {
  const indent = /^ */.exec(text)?.[0] ?? "";
  out(indent + display(text.slice(indent.length)));
}

function intFlag(values: Map<string, string>, name: string): number | undefined {
  const v = values.get(name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new OpenQodexError(`${name} takes a whole number, not ${v}`);
  return Number(v);
}

const VERB: Record<string, string> = { calls: "calls", inherits: "inherits", imports: "imports", overrides: "overrides", implements: "implements", defines: "defines" };

function siteLine(i: Item): string {
  return `${i.site.file}:${i.site.line}`;
}

function itemLine(i: Item, op: Operation): string {
  const tail = `, ${i.site.tier}${i.depth > 1 && op !== "path" ? `, ${i.depth} hops` : ""}${i.site.note ? `: ${i.site.note}` : ""} [${i.edge}]`;
  // A defines hop is a definition held in the body, never a call.
  if (op === "callees") return `${siteLine(i)} ${i.kind === "defines" ? `${i.fromName ?? i.from} defines` : "calls"} ${i.toName ?? i.to}${tail}`;
  if (op === "path" || op === "implementers" || op === "references") return `${siteLine(i)} ${i.fromName ?? i.from} ${VERB[i.kind] ?? i.kind} ${i.toName ?? i.to}${tail}`;
  if (i.kind === "imports") return `${siteLine(i)} imports it${tail}`;
  return `${siteLine(i)} in ${i.fromName ?? i.from}${tail}`;
}

// One fact per line: sites as file:line, tiers spelled out.

function printText(a: Shaped, op: Operation): void {
  if (a.warning) line(`warning: ${a.warning}`);
  if (a.error) {
    line(`${a.error.code}: ${a.error.message}`);
    if (Array.isArray(a.target)) for (const c of a.target) line(`  candidate ${c.file}:${c.line} ${c.kind} ${c.name} (${c.id})`);
  }
  const t = a.target && !Array.isArray(a.target) ? a.target : null;
  if (t) line(`${t.kind} ${t.name} at ${t.file}:${t.line} (${t.id})`);
  else if (Array.isArray(a.target) && !a.error) for (const c of a.target) line(`${c.kind} ${c.name} at ${c.file}:${c.line} (${c.id})`);
  for (const l of a.leads) line(`lead ${l.file}:${l.line} ${l.kind} ${l.name} (${l.id})`);
  a.items.forEach((raw, n) => {
    const i = raw as Item & Record<string, unknown>;
    if (op === "path" && i.site && i.edge) line(`${n + 1}. ${itemLine(i, op)}${i.direction === "reverse" ? " (from the second point to the first)" : ""}`);
    else if (i.site && i.edge) line(itemLine(i, op));
    else if (Array.isArray(i.hops)) line(`${String(i.type)}: ${(i.hops as Item[]).map((h) => `${siteLine(h)} ${h.fromName ?? h.from} ${VERB[h.kind] ?? h.kind} ${h.toName ?? h.to} (${h.site.tier})`).join(" < ")}`);
    else if (op === "cycles" && Array.isArray(i.members)) line(`cycle of ${String(i.size)}: ${(i.members as string[]).join(", ")}`);
    else if (op === "search") line(`match ${String(i.file)}:${String(i.line)} ${String(i.kind)} ${String(i.name)}, ${String(i.tier)} (${String(i.id)})`);
    else if (op === "outline") line(`${String(i.file)}:${String(i.line)} ${String(i.kind)} ${String(i.qualified)}${i.exported ? ", exported" : ""}, ${String(i.callerSites)} call sites in, ${String(i.calleeSites)} out`);
    else line(JSON.stringify(raw));
    if (op === "status" || op === "capabilities") for (const u of (i.unreadLanguages ?? []) as { language: string; files: number }[]) line(unreadNote(u));
  });
  for (const c of a.context?.snippets ?? []) {
    line(`lines around ${c.file}:${c.line}${c.from === null ? ": not readable" : c.changedSince ? ", as this build read them; the file changed since" : ""}`);
    // The source line keeps its own indent; the rest of it goes through display().
    c.lines.forEach((l, k) => {
      const lead = /^[ \t]*/.exec(l)?.[0] ?? "";
      out(`  ${c.start + k}| ${lead.replace(/\t/g, "    ")}${display(l.slice(lead.length))}`);
    });
  }
  // On a floor each certain row is certain, but rows may be missing.
  if (a.counts.certain !== null) line(`counts: ${a.counts.certain} certain${a.unknown.floor ? " (list incomplete)" : ""}, ${a.counts.likely} likely, ${a.counts.possible} possible`);
  const tr = a.truncated;
  if (tr.by === "limit" || (tr.by === "budget" && tr.cursor)) line(tr.note ?? `truncated by ${tr.by}: ${tr.omitted ?? "an unknown number of"} more; --cursor ${tr.cursor}`);
  else if (tr.by === "budget") line(`stopped at the time budget: what lies past ${tr.frontierTotal ?? "the"} unexpanded ${tr.frontierTotal === 1 ? "point" : "points"} is not counted; ask again with a larger --budget-ms`);
  else if (tr.by === "depth") line(`stopped at the depth asked: ${tr.frontierTotal ?? "some"} ${tr.frontierTotal === 1 ? "point has" : "points have"} more past it; --depth goes further`);
  if (a.unknown.floor) line(`floor: ${(a.unknown.scope === "tests" && a.unknown.note) || a.unknown.reasons.join("; ") || "the graph could not see every relation"}`);
  else if (op === "unknowns") for (const r of a.unknown.reasons) line(`note: ${r}`);
  const g = a.graph;
  line(`graph: build ${g.generation ?? "not saved"}, ${g.status}, ${g.mode}${g.reasons.length > 0 ? `: ${g.reasons.join("; ")}` : ""}${g.freshness.laterEditsKnown ? "; files changed since this build" : ""}`);
}

function exitOf(a: Answer): number {
  return a.error === null || a.error.code === "ambiguous" ? EXIT_OK : EXIT_TOOL_FAILED;
}

export async function run(args: string[]): Promise<number> {
  const { global, bools, values, positionals } = parseFlags(args, {
    bools: ["--json", "--full", "--compact", "--exclude-tests"],
    values: ["--file", "--name", "--tier", "--depth", "--limit", "--cursor", "--generation", "--base", "--edges", "--level", "--project", "--text", "--tokens", "--budget-ms", "--context"],
    positionals: 3,
    globals: ["--cwd", "--config", "--quiet"],
  });
  const op = positionals[0];
  if (op === undefined) throw new OpenQodexError(`name a question\n${USAGE}`);
  if (op === "help") {
    out(USAGE);
    return EXIT_OK;
  }
  if (op !== "build" && !(OPERATIONS as readonly string[]).includes(op)) throw new OpenQodexError(`unknown question: ${op}\n${USAGE}`);
  if (positionals.length > (op === "path" ? 3 : 2)) throw new OpenQodexError(`unexpected argument: ${positionals[op === "path" ? 3 : 2]}`);
  const json = bools.has("--json");
  const repoRoot = await findRepoRoot(global.cwd);
  const config = loadConfig(repoRoot, global.config).config;
  const opened = await openStore(repoRoot, { home: openqodexHome(), maxCacheMb: config.graph.maxCacheMb });
  if (!opened.ok) say(`openqodex: the code graph's folder is not used: ${opened.reason}`);
  const store: GraphStore | null = opened.ok ? opened.store : null;
  const progress = (line: string) => {
    if (!global.quiet) say(line);
  };
  const settings = { budgetMs: config.graph.budgetMs, maxFiles: config.graph.maxFiles, maxFileBytes: config.graph.maxFileBytes, maxHeapMb: config.graph.maxHeapMb };

  let pinned: Pinned;
  const generation = values.get("--generation");
  if (generation !== undefined) {
    const fail = (message: string): number => {
      if (json) out(JSON.stringify({ apiVersion: 1, kind: op, error: { code: "generation-unavailable", message } }));
      else line(`generation-unavailable: ${message}`);
      return EXIT_TOOL_FAILED;
    };
    if (!store) return fail("--generation needs the graph folder, and it is not usable here");
    const held = await pinGeneration(store, generation, "cli");
    if ("error" in held) return fail(held.message);
    pinned = held;
  } else {
    const whole = op === "build";
    if (whole && !store) progress("openqodex: building in memory only; nothing is kept");
    // `changes`, and `impact` with no symbol, compare the work tree with its base.
    const compare = op === "changes" || (op === "impact" && positionals[1] === undefined);
    pinned = await pinWorkTree({
      repoRoot,
      store,
      storeRefused: opened.ok ? undefined : opened.reason,
      settings,
      purpose: "cli",
      whole,
      full: bools.has("--full"),
      compare: compare ? { base: values.get("--base"), exclude: config.exclude, defaultBase: config.defaultBase } : undefined,
      onProgress: progress,
    });
  }
  try {
    const { session } = pinned;
    if (generation !== undefined && pinned.reference) session.laterEditsKnown = await laterEdits(repoRoot, pinned.reference, settings.maxFileBytes);
    if (op === "build") {
      const s = session.graph.status;
      if (json) out(JSON.stringify(query(session, { apiVersion: 1, kind: "status" })));
      else {
        line(`Built ${s.filesParsed} of ${s.eligibleFiles} files in ${(s.durationMs / 1000).toFixed(1)} s: ${s.parses} parsed, ${s.cacheHits} from cache, mode ${s.mode} (predicted ${s.predictedMs ?? "?"} ms).`);
        line(`build ${s.generation ?? "not saved"}, ${s.status}${s.reasons.length > 0 ? `: ${s.reasons.join("; ")}` : ""}`);
        for (const u of s.unreadLanguages ?? []) line(unreadNote(u));
      }
      return s.generation === null && store !== null ? EXIT_TOOL_FAILED : EXIT_OK;
    }
    const kind = op as Operation;
    const tiers = values.get("--tier")?.split(",").map((t) => t.trim()) as Request["tiers"];
    const target: Request["target"] =
      kind === "unknowns"
        ? { ...(values.has("--file") ? { file: values.get("--file") } : {}), ...(values.has("--name") ? { name: values.get("--name") } : {}) }
        : kind === "explain"
          ? { id: positionals[1] }
          : kind === "outline" || kind === "importers"
            ? { file: positionals[1] ?? values.get("--file") }
            : kind === "packages"
              ? values.has("--project")
                ? { project: values.get("--project") }
                : {}
              : parseTarget(positionals[1], values.get("--file"));
    const tokens = intFlag(values, "--tokens");
    const ms = intFlag(values, "--budget-ms");
    const request: Request = {
      apiVersion: 1,
      kind,
      target,
      ...(kind === "path" ? { to: parseTarget(positionals[2], undefined) } : {}),
      text: kind === "search" ? positionals[1] : values.get("--text"),
      ...(bools.has("--exclude-tests") ? { excludeTests: true } : {}),
      tiers,
      edges: values.get("--edges")?.split(",").map((e) => e.trim()),
      depth: intFlag(values, "--depth"),
      level: values.get("--level") as Request["level"],
      limit: intFlag(values, "--limit"),
      cursor: values.get("--cursor"),
      ...(tokens !== undefined || ms !== undefined ? { budget: { ...(tokens !== undefined ? { tokens } : {}), ...(ms !== undefined ? { ms } : {}) } } : {}),
    };
    const asked = query(session, request, { changes: pinned.changes, change: pinned.change, scope: pinned.scope });
    const answer = await shapeAnswer(asked, session, { repoRoot, context: intFlag(values, "--context"), compact: json && bools.has("--compact"), maxFileBytes: settings.maxFileBytes });
    if (json) out(JSON.stringify(answer));
    else printText(answer, kind);
    return exitOf(answer);
  } finally {
    pinned.release();
  }
}
