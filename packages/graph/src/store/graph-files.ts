// The files of a generation that hold a graph: the project model
// (projects.json) and, for a build kept as an index, the resolved graph as
// JSON lines (index/*.jsonl). Reading an index back gives the same Graph
// the build made: retained equals fresh (test/session.test.ts checks).
import type { ProjectModel } from "../discovery/projects.js";
import { FRAMEWORK_DATA_VERSION } from "../frameworks/stage.js";
import type { FrameworkData } from "../frameworks/stage.js";
import { projectFolder } from "../resolve.js";
import type { DispatchSite, Graph, GraphEdge, GraphNode, GraphSite, GraphStatus, InvocationSummary, Miss, UnknownSite } from "../types.js";
import type { OpenGeneration } from "./types.js";

// How an index is read back: a file of it by its name, or null when the
// file is not there.
export type ReadIndexFile = (name: string) => string | null;

type Plain = Record<string, unknown>;

export function serializeModel(m: ProjectModel): Plain {
  return {
    node: m.node.map((p) => ({ dir: p.dir, file: p.file, pkg: { ...p.pkg, deps: [...p.pkg.deps] } })),
    members: [...m.members].map(([k, v]) => [k, v.map((p) => p.file)]),
    workspaceFiles: m.workspaceFiles,
    tsconfigs: [...m.tsconfigs.values()],
    pyRoots: m.pyRoots,
    pyDeclared: [...m.pyDeclared],
    goRequires: m.goRequires,
    gems: [...m.gems],
    javaProjects: m.javaProjects,
    javaDeps: [...m.javaDeps],
    pnpmLinks: [...m.pnpmLinks].map(([k, v]) => [k, [...v]]),
    npmLock: [...m.npmLock],
    yarnWorkspace: [...m.yarnWorkspace],
    yarnPublished: [...m.yarnPublished],
    unreadable: m.unreadable,
  };
}

export function deserializeModel(v: Plain): ProjectModel {
  const node = (v.node as { dir: string; file: string; pkg: Plain & { deps: [string, string][] } }[]).map((p) => ({ dir: p.dir, file: p.file, pkg: { ...(p.pkg as object), deps: new Map(p.pkg.deps) } })) as ProjectModel["node"];
  const byFile = new Map(node.map((p) => [p.file, p]));
  return {
    node,
    members: new Map((v.members as [string, string[]][]).map(([k, files]) => [k, files.map((f) => byFile.get(f)).filter((p): p is ProjectModel["node"][number] => p !== undefined)])),
    workspaceFiles: v.workspaceFiles as string[],
    tsconfigs: new Map((v.tsconfigs as ProjectModel["tsconfigs"] extends Map<string, infer T> ? T[] : never).map((t) => [t.dir, t])),
    pyRoots: v.pyRoots as string[],
    pyDeclared: new Set(v.pyDeclared as string[]),
    goRequires: v.goRequires as string[],
    gems: new Set(v.gems as string[]),
    javaProjects: (v.javaProjects as string[] | undefined) ?? [],
    javaDeps: new Set((v.javaDeps as string[] | undefined) ?? []),
    pnpmLinks: new Map((v.pnpmLinks as [string, [string, "workspace" | "published" | "unknown"][]][]).map(([k, list]) => [k, new Map(list)])),
    npmLock: new Map(v.npmLock as [string, "workspace" | "published" | "unknown"][]),
    yarnWorkspace: new Set(v.yarnWorkspace as string[]),
    yarnPublished: new Set(v.yarnPublished as string[]),
    unreadable: (v.unreadable as ProjectModel["unreadable"] | undefined) ?? [],
  };
}

const lines = (items: unknown[]) => items.map((x) => JSON.stringify(x)).join("\n");
const parseLines = <T>(text: string | null): T[] | null => {
  if (text === null) return null;
  try {
    return text === "" ? [] : text.split("\n").map((l) => JSON.parse(l) as T);
  } catch {
    return null;
  }
};

// The resolved graph as files of a generation, in a compact form: every
// string (a path, a symbol id, a note) is written once in
// index/strings.json and rows are arrays that name strings by their
// number. Measured on vscode: the plain JSON lines were 552 MB, past the
// folder's 512 MB bound on their own. 3: the uses that are not calls
// (references), the dispatch sites and the invocation summaries. 4: the
// framework layer's data (index/frameworks.json).
export const INDEX_FORMAT = 4;

type Row = (number | number[])[];

function encoder() {
  const ids = new Map<string, number>();
  const table: string[] = [];
  const s = (v: string | null | undefined): number => {
    if (v === null || v === undefined) return -1;
    let i = ids.get(v);
    if (i === undefined) {
      i = table.length;
      table.push(v);
      ids.set(v, i);
    }
    return i;
  };
  const site = (x: GraphSite): number[] => [s(x.file), x.line, x.column, s(x.tier), s(x.evidence), s(x.via?.file), x.via?.line ?? -1, s(x.via?.spec), s(x.note), s(x.rule)];
  const edge = (e: GraphEdge): Row => [s(e.from), s(e.to), s(e.kind), s(e.tier), ...e.sites.map(site)];
  return { s, site, edge, table };
}

function decoder(table: string[]) {
  const s = (i: number): string => table[i] as string;
  const n = (i: number): string | null => (i < 0 ? null : (table[i] as string));
  const site = (a: number[]): GraphSite => ({
    file: s(a[0] as number),
    line: a[1] as number,
    column: a[2] as number,
    tier: s(a[3] as number) as GraphSite["tier"],
    evidence: s(a[4] as number),
    via: (a[5] as number) < 0 ? null : { file: s(a[5] as number), line: a[6] as number, spec: n(a[7] as number) },
    note: n(a[8] as number),
    rule: s(a[9] as number),
  });
  const edge = (r: Row): GraphEdge => ({ from: s(r[0] as number), to: s(r[1] as number), kind: s(r[2] as number) as GraphEdge["kind"], tier: s(r[3] as number) as GraphEdge["tier"], sites: (r.slice(4) as number[][]).map(site) });
  return { s, n, site, edge };
}

export function writeIndex(g: Graph): Record<string, string> {
  const e = encoder();
  const nodes = [...g.nodes.values()].map((x) => [e.s(x.id), e.s(x.file), e.s(x.name), e.s(x.kind), x.startLine, x.endLine, x.exported ? 1 : 0, e.s(x.lang), e.s(x.bodyHash)]);
  const edges = g.edges.map(e.edge);
  const importers = [...g.importers.values()].flat().map(e.edge);
  const misses = g.misses.map((m) => [e.s(m.target), e.s(m.name), e.s(m.from), e.site(m.site)]);
  const unknowns = g.unknowns.map((u) => [e.s(u.file), u.line, u.column, e.s(u.name), e.s(u.cause), e.s(u.shape), e.s(u.caller), u.scope === "project" ? 1 : 0, e.s(u.note), u.candidates ? u.candidates.map(e.s) : -1]);
  const references = g.references.map(e.edge);
  const dispatch = g.dispatch.map((x) => [e.s(x.file), x.line, x.column, e.s(x.caller), e.s(x.name), x.declared.map(e.s), x.candidates.map(e.s), x.total, e.s(x.rule)]);
  const summaries = [...g.summaries].map(([id, x]) => [e.s(id), x.params.map(e.s), x.invokes, x.returns.map(e.s), x.returnsOther ? 1 : 0]);
  return {
    "projects.json": JSON.stringify({ model: serializeModel(g.model), goModules: g.goModules }),
    "index/format.json": JSON.stringify({ format: INDEX_FORMAT }),
    "index/strings.json": JSON.stringify(e.table),
    "index/nodes.jsonl": lines(nodes),
    "index/edges.jsonl": lines(edges),
    "index/importers.jsonl": lines(importers),
    "index/misses.jsonl": lines(misses),
    "index/unknowns.jsonl": lines(unknowns),
    "index/references.jsonl": lines(references),
    "index/dispatch.jsonl": lines(dispatch),
    "index/summaries.jsonl": lines(summaries),
    "index/status.json": JSON.stringify(g.status),
    "index/frameworks.json": JSON.stringify(g.frameworks ?? null),
  };
}

// A graph read back from a generation's index; null when the generation
// has no index, it is in another format, or a file of it does not parse.
export function readIndex(gen: OpenGeneration): (Omit<Graph, "repoRoot"> & { repoRoot: string }) | null {
  if (!gen.manifest.hasIndex) return null;
  return readIndexFrom((name) => gen.read(name), "");
}

// The same graph from the files `writeIndex` returned, wherever a program
// kept them: `read` gives a file by its name (null when it has none) and
// `repoRoot` is the folder the graph was built from. Null when a file is
// missing, in another format or does not parse.
export function readIndexFrom(read: ReadIndexFile, repoRoot: string): Graph | null {
  let table: string[];
  try {
    if ((JSON.parse(read("index/format.json") ?? "null") as { format?: number } | null)?.format !== INDEX_FORMAT) return null;
    table = JSON.parse(read("index/strings.json") ?? "null") as string[];
    if (!Array.isArray(table)) return null;
  } catch {
    return null;
  }
  const d = decoder(table);
  const rows = (name: string) => parseLines<Row>(read(name));
  const nodeRows = rows("index/nodes.jsonl");
  const edgeRows = rows("index/edges.jsonl");
  const importerRows = rows("index/importers.jsonl");
  const missRows = rows("index/misses.jsonl");
  const unknownRows = rows("index/unknowns.jsonl");
  const referenceRows = rows("index/references.jsonl");
  const dispatchRows = rows("index/dispatch.jsonl");
  const summaryRows = rows("index/summaries.jsonl");
  const statusText = read("index/status.json");
  const projectsText = read("projects.json");
  if (!nodeRows || !edgeRows || !importerRows || !missRows || !unknownRows || !referenceRows || !dispatchRows || !summaryRows || statusText === null || projectsText === null) return null;
  let status: GraphStatus;
  let projects: { model: Plain; goModules: [string, string][] };
  try {
    status = JSON.parse(statusText) as GraphStatus;
    projects = JSON.parse(projectsText) as typeof projects;
    const nodes = nodeRows.map((r): GraphNode => {
      const node: GraphNode = { id: d.s(r[0] as number), file: d.s(r[1] as number), name: d.s(r[2] as number), kind: d.s(r[3] as number) as GraphNode["kind"], startLine: r[4] as number, endLine: r[5] as number, snapshot: "current", exported: r[6] === 1, lang: d.n(r[7] as number) as GraphNode["lang"] };
      const hash = d.n(r[8] as number);
      if (hash !== null) node.bodyHash = hash;
      return node;
    });
    const misses = missRows.map((r): Miss => ({ target: d.s(r[0] as number), name: d.s(r[1] as number), from: d.s(r[2] as number), site: d.site(r[3] as number[]) }));
    const unknowns = unknownRows.map((r): UnknownSite => {
      const u: UnknownSite = { file: d.s(r[0] as number), line: r[1] as number, column: r[2] as number, name: d.s(r[3] as number), cause: d.s(r[4] as number) as UnknownSite["cause"], shape: d.s(r[5] as number) as UnknownSite["shape"], caller: d.s(r[6] as number), scope: r[7] === 1 ? "project" : "file" };
      const note = d.n(r[8] as number);
      if (note !== null) u.note = note;
      if (Array.isArray(r[9])) u.candidates = (r[9] as number[]).map(d.s);
      return u;
    });
    const dispatch = dispatchRows.map((r): DispatchSite => ({
      file: d.s(r[0] as number),
      line: r[1] as number,
      column: r[2] as number,
      caller: d.s(r[3] as number),
      name: d.s(r[4] as number),
      declared: (r[5] as number[]).map(d.s),
      candidates: (r[6] as number[]).map(d.s),
      total: r[7] as number,
      rule: d.s(r[8] as number) as DispatchSite["rule"],
    }));
    const summaries = new Map<string, InvocationSummary>(summaryRows.map((r) => [d.s(r[0] as number), { params: (r[1] as number[]).map(d.s), invokes: r[2] as number[], returns: (r[3] as number[]).map(d.s), returnsOther: r[4] === 1 }]));
    const extra = { references: referenceRows.map(d.edge), dispatch, summaries };
    const graph = assemble(nodes, edgeRows.map(d.edge), importerRows.map(d.edge), misses, unknowns, status, deserializeModel(projects.model), projects.goModules, extra);
    graph.repoRoot = repoRoot;
    const frameworks = JSON.parse(read("index/frameworks.json") ?? "null") as FrameworkData | null;
    if (frameworks !== null) {
      if (typeof frameworks !== "object" || frameworks.version !== FRAMEWORK_DATA_VERSION || !Array.isArray(frameworks.edges) || !Array.isArray(frameworks.entities)) return null;
      graph.frameworks = frameworks;
    }
    return graph;
  } catch {
    return null;
  }
}

export function assemble(
  nodeList: GraphNode[],
  edges: GraphEdge[],
  importerEdges: GraphEdge[],
  misses: Miss[],
  unknowns: UnknownSite[],
  status: GraphStatus,
  model: ProjectModel,
  goModules: [string, string][],
  extra: Pick<Graph, "references" | "dispatch" | "summaries"> = { references: [], dispatch: [], summaries: new Map() },
): Graph {
  const nodes = new Map<string, GraphNode>();
  const defsByFile = new Map<string, GraphNode[]>();
  for (const n of nodeList) {
    nodes.set(n.id, n);
    if (n.kind !== "file") (defsByFile.get(n.file) ?? defsByFile.set(n.file, []).get(n.file))?.push(n);
    else if (!defsByFile.has(n.file)) defsByFile.set(n.file, []);
  }
  const graphIn = new Map<string, GraphEdge[]>();
  const graphOut = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    (graphIn.get(e.to) ?? graphIn.set(e.to, []).get(e.to))?.push(e);
    (graphOut.get(e.from) ?? graphOut.set(e.from, []).get(e.from))?.push(e);
  }
  const refsIn = new Map<string, GraphEdge[]>();
  const refsOut = new Map<string, GraphEdge[]>();
  for (const e of extra.references) {
    (refsIn.get(e.to) ?? refsIn.set(e.to, []).get(e.to))?.push(e);
    (refsOut.get(e.from) ?? refsOut.set(e.from, []).get(e.from))?.push(e);
  }
  const importers = new Map<string, GraphEdge[]>();
  for (const e of importerEdges) (importers.get(e.to) ?? importers.set(e.to, []).get(e.to))?.push(e);
  const projectOf = (file: string) => projectFolder(model, goModules, file);
  const unknownNames = new Map<string, number>();
  const valueCalls = new Map<string, number>();
  for (const u of unknowns) {
    if (u.name !== "") unknownNames.set(u.name, (unknownNames.get(u.name) ?? 0) + 1);
    if (u.scope === "project" && u.cause !== "metadata-unreadable") valueCalls.set(projectOf(u.file), (valueCalls.get(projectOf(u.file)) ?? 0) + 1);
  }
  return {
    repoRoot: "",
    nodes,
    edges,
    in: graphIn,
    out: graphOut,
    references: extra.references,
    refsIn,
    refsOut,
    dispatch: extra.dispatch,
    summaries: extra.summaries,
    importers,
    defsByFile,
    removed: new Map(),
    misses,
    unknowns,
    unknownNames,
    valueCalls,
    model,
    goModules,
    projectOf,
    exportChanges: [],
    status,
  };
}
