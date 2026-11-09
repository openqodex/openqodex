// Identifiers on the changed lines, ranked by rarity, with their other
// declarations and uses. The snapshot is plain files, not a git database.
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedHunks, display, escapeMarkdown, redactSecrets, secretTexts } from "@openqodex/core";
import type { Change, ImpactSummary } from "@openqodex/core";
import { PACKET_DIR, PACKET_ROOT } from "@openqodex/graph";
import { redactStored } from "./redact.js";
import { snapshotText } from "./snapshot.js";

// One place a symbol occurs. `kind` says whether a declaration regex matched
// the line (a label, never a selector). `context` is the lines around it,
// numbered as the snapshot holds them. `from` says who found it.
export type NeighbourhoodSite = { path: string; line: number; kind: "declared" | "used"; context: string; from: "graph" | "text" };

// One symbol: its name, the changed files that hold or touch it, its file
// count, and its sites. `filesOverCap` is the threshold where counting
// stopped; above it, only certain graph sites are kept.
export type NeighbourhoodSymbol = { name: string; changedIn: string[]; files: number; filesOverCap?: number; sites: NeighbourhoodSite[] };

// The packet: the symbols, where the packet was written inside the snapshot
// (a path relative to the snapshot root, null when nothing was written), and
// whether the time or size cap cut it (`partial` with the reason).
export type Neighbourhood = {
  symbols: NeighbourhoodSymbol[];
  packetPath: string | null;
  partial: string | null;
  durationMs: number;
};

export const NEIGHBOURHOOD_TIME_MS = 10_000;
export const NEIGHBOURHOOD_MAX_BYTES = 64 * 1024;
export const NEIGHBOURHOOD_BLOCK_BYTES = 24 * 1024;
export const NEIGHBOURHOOD_MAX_FILES_PER_SYMBOL = 200;
export const NEIGHBOURHOOD_SITES_PER_SYMBOL = 12;
export const NEIGHBOURHOOD_SYMBOLS_PER_FILE = 30;

const MAX_TEXT_BYTES = 512 * 1024;
const IGNORED = new Set([".git", "node_modules", "vendor", "dist", "build", "target", ".openqodex", PACKET_ROOT]);
const STOP_WORDS = new Set([
  "if", "else", "for", "while", "return", "function", "const", "let", "var", "val", "def", "class", "import", "from",
  "this", "self", "true", "false", "null", "None", "new", "public", "private", "protected", "static", "void", "int",
  "string", "bool", "boolean", "char", "float", "double", "long", "short", "unsigned", "struct", "interface", "enum",
  "trait", "func", "fun", "sub", "procedure", "export", "default", "async", "await", "try", "catch", "throw", "throws",
  "extends", "implements", "final", "switch", "case", "break", "continue", "with", "pass", "and", "not", "print",
]);
const IDENTIFIER = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;
// These only label a matched site. They never choose which names to search.
const DECLARATIONS = [
  /\b(?:function|def|func|fn|class|struct|interface|enum|trait|fun|sub|procedure)\s+([A-Za-z_][A-Za-z0-9_]{2,})\b/g,
  // A name at the start of a line whose parameter list ends the line with a
  // body opener. A plain call (`reprice(10)`, with or without `;`) is a use.
  /^\s*([A-Za-z_][A-Za-z0-9_]{2,})\s*\(.*\)\s*(?:\{|:|=>)\s*$/g,
  /\b(?:const|let|var|val)\s+([A-Za-z_][A-Za-z0-9_]{2,})\b/g,
  /\b(?:public|private|protected|internal)\s+(?:(?:static|final|abstract|virtual|override|async)\s+)*[A-Za-z_][A-Za-z0-9_<>,.?[\]]*\s+([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g,
];
const HEADER = "## Code around the change\n\nThe identifiers on the changed lines, and where the repository declares and uses them. Graph entries are certain callers; name matches are unverified. Read the other side of every changed call here before judging it.";
const PACKET_PATH = `${PACKET_ROOT}/neighbourhood.md`;

type Collected = { name: string; files: number; graph: NeighbourhoodSite[]; declared: NeighbourhoodSite[]; used: NeighbourhoodSite[] };
type GraphSites = Map<string, Map<number, Set<string>>>;

function eligible(path: string): boolean {
  return !path.split("/").some((part) => IGNORED.has(part));
}

function declaredNames(line: string): Set<string> {
  return new Set(DECLARATIONS.flatMap((pattern) => [...line.matchAll(pattern)].map((m) => m[1])));
}

function contextAt(lines: string[], index: number, secrets: string[]): string {
  // Two lines above, the site, and two below, clipped at the file's ends.
  // Redact before clipping so a cut cannot leave part of a secret behind.
  const start = Math.max(0, index - 2);
  return lines.slice(start, index + 3).map((line, i) => {
    const clean = redactSecrets(line, secrets);
    return `${start + i + 1}\t${clean.length > 240 ? `${clean.slice(0, 240)} [cut]` : clean}`;
  }).join("\n");
}

// Only the edge into the touched symbol proves a caller of that symbol.
// A second hop calls the first caller, not necessarily the changed name.
function graphSites(impact: ImpactSummary | null, names: Map<string, Collected>): GraphSites {
  const out: GraphSites = new Map();
  if (!impact) return out;
  const symbols = new Map(impact.symbols.map((s) => [s.id, s]));
  const touched = new Set([...impact.touched, ...impact.removed]);
  for (const path of impact.callers) {
    const target = symbols.get(path.seed);
    if (!target || !touched.has(target.id) || !names.has(target.name)) continue;
    const edge = path.edges[0];
    if (edge.to !== target.id) continue;
    for (const site of edge.sites) {
      if (site.tier !== "certain") continue;
      let lines = out.get(site.file);
      if (!lines) out.set(site.file, (lines = new Map()));
      let at = lines.get(site.line);
      if (!at) lines.set(site.line, (at = new Set()));
      at.add(target.name);
    }
  }
  return out;
}

function renderSymbol(symbol: NeighbourhoodSymbol): string {
  const count = symbol.filesOverCap === undefined ? String(symbol.files) : `over ${symbol.filesOverCap}`;
  const out = [`#### ${escapeMarkdown(display(symbol.name))}: ${count} snapshot files`];
  for (const site of symbol.sites) {
    const from = site.from === "graph" ? "from the code graph" : "by name, unverified: the same name may be another thing";
    // A repository fence must not close the fence around its context.
    let longest = 2;
    for (const match of site.context.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    const fence = "`".repeat(longest + 1);
    out.push(`${site.kind} at ${escapeMarkdown(display(site.path))}:${site.line} (${from})\n\n${fence}\n${site.context}\n${fence}`);
  }
  return out.join("\n\n");
}

// Both budgets keep whole symbols, including all their changed-file headings.
function capped(symbols: NeighbourhoodSymbol[], maxBytes: number, tail: (kept: number) => string[], forFiles?: ReadonlySet<string>): { symbols: NeighbourhoodSymbol[]; text: string } {
  const kept: NeighbourhoodSymbol[] = [];
  const files = new Map<string, { heading: string; entries: string[] }>();
  // Reserve the longest omission note. Its count can only shrink as we keep
  // symbols. The last byte is the final newline.
  const notes = tail(0);
  const reserved = notes.length > 0 ? Buffer.byteLength(notes.join("\n\n")) + 2 : 0;
  let bytes = Buffer.byteLength(HEADER) + reserved + 1;
  for (const symbol of symbols) {
    const paths = symbol.changedIn.filter((file) => !forFiles || forFiles.has(file));
    if (paths.length === 0) continue;
    const text = renderSymbol(symbol);
    const entryBytes = Buffer.byteLength(text) + 2;
    const headings = paths.map((file) => files.get(file)?.heading ?? `### ${escapeMarkdown(display(file))}`);
    const extra = paths.reduce((size, file, i) => size + entryBytes + (files.has(file) ? 0 : Buffer.byteLength(headings[i]) + 2), 0);
    if (bytes + extra > maxBytes) continue;
    bytes += extra;
    kept.push(symbol);
    for (const [i, file] of paths.entries()) {
      let group = files.get(file);
      if (!group) files.set(file, (group = { heading: headings[i], entries: [] }));
      group.entries.push(text);
    }
  }
  const out = [HEADER];
  for (const group of files.values()) out.push(group.heading, ...group.entries);
  out.push(...tail(kept.length));
  return { symbols: kept, text: out.join("\n\n") + "\n" };
}

function writePacket(snapshotDir: string, impact: ImpactSummary | null, text: string): void {
  try {
    mkdirSync(join(snapshotDir, PACKET_ROOT), { mode: 0o700 });
  } catch (error) {
    // The graph writer reserves this root exclusively. Share only its known
    // directory, after it ran, and never follow a repository link.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (impact?.packet !== `${PACKET_DIR}/` || !lstatSync(join(snapshotDir, PACKET_ROOT)).isDirectory() || !lstatSync(join(snapshotDir, PACKET_DIR)).isDirectory()) {
      throw new Error(`Packet collision: ${PACKET_ROOT} already exists or is a link`);
    }
  }
  try {
    writeFileSync(join(snapshotDir, PACKET_PATH), text, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Packet collision: ${PACKET_PATH} already exists`);
    throw error;
  }
}

// Builds the packet from the change and the snapshot tree and writes it
// inside the snapshot (the caller takes the snapshot's hash afterwards).
// `impact`: the graph's view, whose certain callers are listed first.
// Run after the graph's writePacket, passing the impact with its `packet`
// path. Creating PACKET_ROOT here first would make writePacket throw
// PacketCollision when it tries to reserve that directory.
// Never throws: a failure is a packet with `partial` set and no symbols.
export function buildNeighbourhood(args: { change: Change; snapshotDir: string; impact: ImpactSummary | null; secrets: string[]; now?: () => number; maxFilesPerSymbol?: number }): Neighbourhood {
  const now = args.now ?? Date.now;
  let started = 0;
  let elapsed = 0;
  let timedOut = false;
  const duration = (): number => {
    elapsed = Math.max(elapsed, now() - started);
    return elapsed;
  };
  const expired = (): boolean => {
    timedOut ||= duration() >= NEIGHBOURHOOD_TIME_MS;
    return timedOut;
  };
  try {
    started = now();
    const paths: string[] = [];
    const walk = (dir: string): void => {
      if (expired()) return;
      for (const entry of readdirSync(join(args.snapshotDir, dir), { withFileTypes: true })) {
        if (IGNORED.has(entry.name)) continue;
        const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) paths.push(path);
        if (timedOut) break;
      }
    };
    walk("");
    paths.sort();
    const present = new Set(paths);
    // Changed files still seed names even when their directory has no sites.
    for (const file of args.change.files) {
      if (eligible(file.path)) continue;
      if (expired()) break;
      try { if (lstatSync(join(args.snapshotDir, file.path)).isFile()) present.add(file.path); }
      catch { /* A deleted file has no snapshot text to seed. */ }
    }
    const readText = snapshotText(args.snapshotDir);
    let filesRead = 0;
    const read = (path: string): string[] | null => {
      if (!present.has(path)) return null;
      if (lstatSync(join(args.snapshotDir, path)).size > MAX_TEXT_BYTES) return null;
      const text = readText(path);
      if (text === null) return null;
      filesRead++;
      const lines = text.split(/\r?\n/);
      if (lines[lines.length - 1] === "") lines.pop();
      return lines;
    };
    const names = new Map<string, Collected>();
    const byFile = new Map<string, Set<string>>();
    const binary = new Set(args.change.files.filter((f) => f.binary).map((f) => f.path));
    for (const file of args.change.files) if (!file.binary) byFile.set(file.path, new Set());
    const addName = (file: string, name: string): void => {
      let inFile = byFile.get(file);
      if (!inFile) byFile.set(file, (inFile = new Set()));
      inFile.add(name);
      if (!names.has(name)) names.set(name, { name, files: 0, graph: [], declared: [], used: [] });
    };
    const add = (file: string, line: string): void => {
      if (binary.has(file)) return;
      for (const [name] of line.matchAll(IDENTIFIER)) {
        if (STOP_WORDS.has(name)) continue;
        addName(file, name);
      }
    };
    // A body edit need not spell its enclosing symbol's name. The graph
    // knows which declarations were touched or removed, even without text.
    const touched = new Set([...(args.impact?.touched ?? []), ...(args.impact?.removed ?? [])]);
    for (const symbol of args.impact?.symbols ?? []) if (touched.has(symbol.id)) addName(symbol.file, symbol.name);

    for (const diff of args.change.diffs ?? []) {
      if (expired()) break;
      let inHunk = false;
      let n = 0;
      for (const line of diff.text.split("\n")) {
        if (n++ % 256 === 0 && expired()) break;
        if (line.startsWith("@@")) inHunk = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line);
        else if (inHunk && line.startsWith("-")) add(diff.path, line.slice(1));
        else if (!/^[ +\\]/.test(line)) inHunk = false;
      }
    }
    const ranges = new Map<string, { start: number; end: number }[]>();
    for (const hunk of changedHunks(args.change)) {
      if (hunk.deletion || binary.has(hunk.path)) continue;
      let inFile = ranges.get(hunk.path);
      if (!inFile) ranges.set(hunk.path, (inFile = []));
      inFile.push(hunk);
    }
    const totalFiles = new Set([...paths, ...ranges.keys()].filter((path) => present.has(path))).size;
    // Changed files are read first to discover every candidate. Keep their
    // split lines until the single counting pass, so none is read twice.
    const cached = new Map<string, string[] | null>();
    for (const [path, hunks] of ranges) {
      if (expired()) break;
      const lines = read(path);
      cached.set(path, lines);
      if (!lines) continue;
      for (const hunk of hunks) {
        for (let i = Math.max(0, hunk.start - 1); i < Math.min(lines.length, hunk.end); i++) {
          if (i % 256 === 0 && expired()) break;
          add(path, lines[i]);
        }
        if (timedOut) break;
      }
    }
    const graph = graphSites(args.impact, names);
    const maxFiles = args.maxFilesPerSymbol ?? NEIGHBOURHOOD_MAX_FILES_PER_SYMBOL;
    for (const path of paths) {
      if (expired()) break;
      const lines = cached.has(path) ? cached.get(path)! : read(path);
      cached.delete(path);
      if (!lines) continue;
      const seen = new Set<string>();
      const changed = args.change.coverage.get(path);
      const graphLines = graph.get(path);
      for (let i = 0; i < lines.length; i++) {
        if (i % 256 === 0 && expired()) break;
        const matches = new Set<string>();
        for (const [name] of lines[i].matchAll(IDENTIFIER)) {
          const symbol = names.get(name);
          if (!symbol || symbol.files > maxFiles) continue;
          if (!seen.has(name)) {
            seen.add(name);
            symbol.files++;
            if (symbol.files > maxFiles) {
              symbol.declared = []; symbol.used = [];
              continue;
            }
          }
          matches.add(name);
        }
        if (changed?.has(i + 1)) continue;
        let context: string | undefined;
        const at = graphLines?.get(i + 1);
        for (const name of at ?? []) {
          const symbol = names.get(name)!;
          if (symbol.graph.length >= NEIGHBOURHOOD_SITES_PER_SYMBOL) continue;
          symbol.graph.push({ path, line: i + 1, kind: "used", from: "graph", context: context ??= contextAt(lines, i, args.secrets) });
        }
        if (matches.size === 0) continue;
        const declared = declaredNames(lines[i]);
        for (const name of matches) {
          if (at?.has(name)) continue;
          const symbol = names.get(name)!;
          const kind = declared.has(name) ? "declared" : "used";
          const sites = symbol[kind];
          if (sites.length < NEIGHBOURHOOD_SITES_PER_SYMBOL) sites.push({ path, line: i + 1, kind, from: "text", context: context ??= contextAt(lines, i, args.secrets) });
        }
      }
    }
    const selected = new Map<string, NeighbourhoodSymbol>();
    for (const [file, candidates] of byFile) {
      const ranked = [...candidates].map((name) => names.get(name)!)
        .filter((s) => s.graph.length > 0 || (s.files <= maxFiles && s.declared.length + s.used.length > 0))
        .sort((a, b) => a.files - b.files || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, NEIGHBOURHOOD_SYMBOLS_PER_FILE);
      for (const symbol of ranked) {
        let kept = selected.get(symbol.name);
        if (!kept) {
          kept = {
            name: symbol.name, files: symbol.files, changedIn: [],
            ...(symbol.files > maxFiles ? { filesOverCap: maxFiles } : {}),
            sites: (symbol.files > maxFiles ? symbol.graph : [...symbol.graph, ...symbol.declared, ...symbol.used]).slice(0, NEIGHBOURHOOD_SITES_PER_SYMBOL),
          };
          selected.set(symbol.name, kept);
        }
        kept.changedIn.push(file);
      }
    }
    duration();
    const symbols = redactStored([...selected.values()], args.secrets);
    const timeReason = timedOut ? `Time cap reached after ${filesRead} of ${totalFiles} files; file counts and sites are partial.` : null;
    if (symbols.length === 0) return { symbols, packetPath: null, partial: timeReason, durationMs: elapsed };
    const sizeReason = (kept: number) => kept < symbols.length ? `${symbols.length - kept} symbols cut at the packet byte cap.` : null;
    const fit = capped(symbols, NEIGHBOURHOOD_MAX_BYTES, (kept) => [timeReason, sizeReason(kept)].filter((x): x is string => x !== null));
    const text = redactSecrets(fit.text, args.secrets);
    if (secretTexts(args.secrets).some((secret) => PACKET_PATH.includes(secret) || text.includes(secret))) throw new Error("A secret remains in the neighbourhood packet or its path");
    writePacket(args.snapshotDir, args.impact, text);
    duration();
    return { symbols: fit.symbols, packetPath: PACKET_PATH, partial: [timeReason, sizeReason(fit.symbols.length)].filter(Boolean).join(" ") || null, durationMs: elapsed };
  } catch (error) {
    try { duration(); } catch { /* Keep the last duration if the clock failed. */ }
    return { symbols: [], packetPath: null, partial: redactSecrets(`Could not build code around the change: ${display(error instanceof Error ? error.message : String(error))}`, args.secrets), durationMs: elapsed };
  }
}

// The "## Code around the change" block for a brief: the entries whose
// symbols were changed in `forFiles` (every changed file when left out), at
// most NEIGHBOURHOOD_BLOCK_BYTES, and the packet's path for the rest. Empty
// string when the packet has nothing.
export function renderNeighbourhoodBlock(packet: Neighbourhood, forFiles?: readonly string[]): string {
  const files = forFiles ? new Set(forFiles) : undefined;
  const symbols = packet.symbols.filter((s) => !files || s.changedIn.some((file) => files.has(file)));
  if (symbols.length === 0) return "";
  return capped(symbols, NEIGHBOURHOOD_BLOCK_BYTES, (kept) => {
    const notes = packet.partial ? [packet.partial] : [];
    if (kept < symbols.length) notes.push(packet.packetPath ? `Read ${escapeMarkdown(display(packet.packetPath))} for the remaining ${symbols.length - kept} symbols.` : `${symbols.length - kept} symbols left out; no packet was written.`);
    return notes;
  }, files).text;
}
