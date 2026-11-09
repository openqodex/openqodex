// The brief's "What this change reaches" block, rendered from the same
// ImpactSummary the report carries (PLAN.md 3.4): coverage first, then the
// symbols the change touched, removed or moved with the public names it
// removed or bound elsewhere, then the callers by tier with their evidence
// (certain, likely, then possible: a call through an interface or a base
// type, a function value something may call), then the other uses of the
// touched code, then what the graph could not see near the change.
// Every cut names the packet file that holds the rest; the packet lies
// inside the folder the reviewer reads, so following the brief never reads
// outside it.
//
// File paths, symbol names and the notes and reasons that quote them come
// from the repository, and the reviewer reads this text (#71). So each is
// made one line by core's `display` (line breaks and every other run of
// whitespace become one space; control characters are dropped): a name is
// a bounded code span whose own quote character is replaced, a path and a
// note have every character markdown gives meaning to escaped with core's
// `escapeMarkdown`. Repository text never starts a line of the brief and
// never opens markdown in it. As the framework lines do
// (frameworks/render.ts).
import { display, escapeMarkdown } from "@openqodex/core";
import type { ImpactEdge, ImpactSite, ImpactSummary, ImpactSymbol } from "@openqodex/core";
import { renderFrameworkLines } from "./frameworks/render.js";
import { INLINE_POSSIBLE, INLINE_SITES } from "./impact.js";
import { TIER_RANK, weakest } from "./model/records.js";

const MAX_NAME = 120;
const MAX_PROSE = 600;

function bounded(text: string, max: number): string {
  const one = display(text).trim();
  const chars = [...one];
  return chars.length > max ? `${chars.slice(0, max - 3).join("")}...` : one;
}

// A name from the repository: one line, bounded, a code span that cannot be closed from inside.
// The packet's index.md uses it too.
export function code(text: string): string {
  return `\`${bounded(text, MAX_NAME).replaceAll("`", "'")}\``;
}

// A path from the repository: one line, markdown escaped, never cut (the reviewer opens it).
export function path(text: string): string {
  return escapeMarkdown(display(text).trim());
}

// Prose that quotes the repository (a note, a reason): one line, bounded, markdown escaped.
function prose(text: string): string {
  return escapeMarkdown(bounded(text, MAX_PROSE));
}

const MAX_TOUCHED = 25;
const MAX_IMPORTERS = 12;
const MAX_CALLEES = 12;
const MAX_EXPORTS = 12;
const MAX_CONSUMERS = 8;
const MAX_NEAR = 12;
const MAX_FLOOR_SEEDS = 8;
const MAX_REFERENCES = 20;

function n(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

// The key a symbol's packet files are named by.
export function symbolKey(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  const name = id.slice(id.indexOf("#") + 1, id.lastIndexOf("@")).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
  return `${name || "file"}-${h.toString(16).padStart(8, "0")}`;
}

const instruction = (packet: string | null) =>
  [
    "How to read this block. A change in behaviour to a touched symbol (its signature, return shape, errors, side effects or ordering) can break a caller outside the diff. Open the call sites that matter for this change and read them. Raise a finding only when a caller actually breaks, and anchor it on the changed line that breaks it.",
    "\"certain\" means an import, a definition in the same scope or a known receiver type proves the call, and every step it rests on is proved. \"likely\" means a stated convention picked the one target; its note says which, and it is a lead to check, not a fact. \"possible\" means the call may run this code and nothing proves it does: a call through an interface or a base type that one of several implementations or overrides answers, or a function used as a value that a callee, an alias, a table or a returned value may call. A possible caller is a lead to check, never proof that the code runs, and never proof that nothing else does.",
    "A caller list marked as a floor may be short: the graph could not bind some calls (a value of unknown type, a callback, a computed member), a call may reach the symbol only possibly, or some files were not read. Zero callers on a floor never means unused.",
    packet !== null
      ? `Everything this block leaves out is in \`${packet}\`, inside the folder you read: \`index.md\` lists the files, \`callers/<key>.json\` holds every caller of a symbol with its tier, \`implementers/<key>.json\` what implements or overrides it, \`references/<key>.json\` where it is used as a value or a type, \`unknowns.json\` what the graph could not see. Reading them does not count as reading the changed lines.`
      : "",
  ]
    .filter((l) => l !== "")
    .join(" ");

// A caller two hops out is as sure as the weaker of its own call and the
// step it reaches the change through (that step's surest site); a weaker
// step brings its note.
function throughStep(site: ImpactSite, step: ImpactSite | null): ImpactSite {
  if (step === null || TIER_RANK[step.tier] >= TIER_RANK[site.tier]) return site;
  const notes = [site.note, step.note].filter((n): n is string => typeof n === "string" && n !== "");
  return { ...site, tier: weakest(site.tier, step.tier), note: notes.length > 0 ? [...new Set(notes)].join(" ") : null };
}

// A method as `Owner.name`, anything else by its name.
function qualifiedOf(id: string, fallback: string): string {
  const hash = id.indexOf("#");
  const at = id.lastIndexOf("@");
  return hash >= 0 && at > hash ? id.slice(hash + 1, at) : fallback;
}

const VERB: Record<string, string> = { calls: "calls", inherits: "extends", implements: "implements", dispatches_to: "may call", may_invoke: "may invoke" };

function siteTier(site: ImpactSite): string {
  if (site.tier === "certain") return "certain";
  return site.note ? `${site.tier}: ${prose(site.note)}` : site.tier;
}

// `overflow`: where the rest is when there is no packet (the agent-led
// review keeps impact.json beside its brief, in a folder that agent reads).
export function renderImpactBlock(impact: ImpactSummary, opts: { overflow?: string } = {}): string {
  const out = ["## What this change reaches", ""];
  if (impact.status === "off" || impact.status === "skipped" || impact.status === "failed") {
    const why = prose(impact.reasons.join("; ")) || impact.status;
    const lead = impact.status === "off" ? "The code graph is off" : impact.status === "skipped" ? "The code graph was skipped" : "The code graph could not be built";
    out.push(`${lead}: ${why}. Find the callers of changed code with your own tools.`);
    return out.join("\n");
  }
  const b = impact.build;
  const packet = impact.packet;
  const at = (rel: string, lead = ", in") => (packet ? `${lead} \`${packet}${rel}\`` : opts.overflow ? `, listed in ${opts.overflow}` : "");

  // 1. Coverage.
  const counted = b.unresolvedSites === null ? "" : `; ${n(b.unresolvedSites, "call site")} in the repository could not be bound`;
  out.push(`Built on this machine from ${n(b.parsedFiles, "file")} of ${n(b.eligibleFiles, "eligible file")} in ${seconds(b.durationMs)}${b.mode ? `, ${b.mode === "fresh" ? "fresh from cached facts" : "from the retained index"}` : ""}${counted}.`);
  if (impact.status === "partial") {
    out.push(`The graph is partial: ${prose(impact.reasons.join("; "))}. Callers in the files left out are missing, so check the ones that matter with your own tools.`);
  }

  const sym = new Map<string, ImpactSymbol>(impact.symbols.map((s) => [s.id, s]));
  // A symbol's name as a code span (a file's top level by its path); where it is, escaped.
  const name = (id: string) => code(sym.get(id)?.name ?? id);
  const where = (s: ImpactSymbol) => `${path(s.file)}:${s.startLine}`;
  const moved = impact.removed.filter((id) => sym.get(id)?.movedTo);
  const removed = impact.removed.filter((id) => !sym.get(id)?.movedTo);

  if (impact.touched.length === 0 && impact.removed.length === 0 && impact.exports.length === 0) {
    out.push("", "The change touches no function, method, class or type in a TypeScript, JavaScript, Python, Go, Ruby or Java file, so there is no caller to trace.");
    pushImporters(out, impact, at);
    out.push(...renderFrameworkLines(impact.frameworks, packet));
    return out.join("\n");
  }

  out.push("", instruction(packet));
  const possible = impact.possible ?? [];
  const callerIds = new Set(impact.callers.map((p) => (p.edges[p.edges.length - 1] as ImpactEdge).from));
  const callerFiles = new Set(impact.callers.flatMap((p) => (p.edges[p.edges.length - 1] as ImpactEdge).sites.map((s) => s.file)));
  const possibleIds = new Set(possible.map((p) => (p.edges[p.edges.length - 1] as ImpactEdge).from));
  const parts = [n(impact.touched.length, "symbol") + " touched"];
  if (removed.length > 0) parts.push(`${removed.length} removed`);
  if (moved.length > 0) parts.push(`${moved.length} moved`);
  if (impact.exports.length > 0) parts.push(`${n(impact.exports.length, "public name")} changed`);
  parts.push(`${n(callerIds.size, "caller")} in ${n(callerFiles.size, "file")}${possibleIds.size > 0 ? ` and ${n(possibleIds.size, "possible caller")}` : ""}${impact.unknown.floor ? ", a floor" : ""}`);
  out.push("", `Risk: ${impact.risk ?? "none"} (${parts.join(", ")})`);

  // 3. Touched, removed and moved symbols, and the export surface diff.
  if (impact.touched.length > 0) {
    out.push("", "Touched symbols:");
    for (const id of impact.touched.slice(0, MAX_TOUCHED)) {
      const s = sym.get(id);
      if (s) out.push(`- ${where(s)} ${code(s.name)} (${s.kind})`);
    }
    if (impact.touched.length > MAX_TOUCHED) out.push(`- and ${impact.touched.length - MAX_TOUCHED} more`);
  }
  if (removed.length > 0) {
    const called = new Map<string, number>();
    for (const p of impact.callers) {
      const first = p.edges[0] as ImpactEdge;
      if (p.edges.length === 1 && removed.includes(p.seed)) called.set(p.seed, (called.get(p.seed) ?? 0) + first.sites.length);
    }
    // A hub's list was cut to its nearest callers; its count was taken before the cut.
    for (const h of impact.hubs) if (removed.includes(h.symbol)) called.set(h.symbol, h.sites);
    out.push("", "Removed by this change (from the base version):");
    for (const id of removed.slice(0, MAX_TOUCHED)) {
      const s = sym.get(id);
      if (!s) continue;
      const c = called.get(id) ?? 0;
      out.push(`- ${where(s)} ${code(s.name)} (${s.kind})${c > 0 ? `, still called from ${n(c, "site")}` : ""}`);
    }
    if (removed.length > MAX_TOUCHED) out.push(`- and ${removed.length - MAX_TOUCHED} more`);
  }
  if (moved.length > 0) {
    out.push("", "Moved to another file by this change:");
    for (const id of moved.slice(0, MAX_TOUCHED)) {
      const s = sym.get(id);
      if (!s?.movedTo) continue;
      const to = s.movedTo.renamed ? `moved and renamed to ${name(s.movedTo.id)} at ${path(s.movedTo.file)}:${s.movedTo.line} (the same body)` : `moved to ${path(s.movedTo.file)}:${s.movedTo.line}`;
      out.push(`- ${where(s)} ${code(s.name)} (${s.kind}), ${to}`);
    }
    if (moved.length > MAX_TOUCHED) out.push(`- and ${moved.length - MAX_TOUCHED} more`);
  }
  if (impact.exports.length > 0) {
    out.push("", "Public names this change removed or bound to another definition (compared in the base and the changed version):");
    for (const e of impact.exports.slice(0, MAX_EXPORTS)) {
      const what = e.change === "removed" ? "no longer exported" : `now bound to ${e.after ? `${name(e.after.id)} at ${path(e.after.file)}:${e.after.line}` : "another definition"}`;
      const was = e.before ? `, was ${path(e.before.file)}:${e.before.line}` : "";
      const users = e.consumersTotal === 0 ? "no consumer in the repository used it" : `${n(e.consumersTotal, "site")} used it`;
      out.push(`- ${code(e.name)} in ${path(e.file)}${e.line ? `:${e.line}` : ""}: ${what}${was}; ${users}`);
      for (const c of e.consumers.slice(0, MAX_CONSUMERS)) {
        const now = c.now === "broken" ? "binds nothing now" : c.now === "retargeted" ? "binds another definition now" : c.now === "unchanged" ? "binds the same definition now" : "its file changed too";
        out.push(`  - ${path(c.file)}:${c.line} in ${name(c.from)}, ${now}`);
      }
      const more = e.consumersTotal - Math.min(e.consumers.length, MAX_CONSUMERS);
      // The packet holds every consumer; impact.json beside the brief holds the summary's first ones.
      const held = e.consumers.length - Math.min(e.consumers.length, MAX_CONSUMERS);
      if (more > 0) out.push(`  - and ${more} more${packet || held === more ? at("changes.json") : held > 0 && opts.overflow ? `; ${opts.overflow} lists ${held} of them` : ""}`);
    }
    if (impact.exports.length > MAX_EXPORTS) out.push(`- and ${impact.exports.length - MAX_EXPORTS} more${at("changes.json")}`);
  }

  // 4. Callers by tier: certain first, then likely with their notes, then
  // possible (each step of a path counted at its weakest), capped apart.
  const rowsOf = (paths: typeof impact.callers, qualified: boolean): { tier: number; text: string }[] => {
    const rows: { tier: number; text: string }[] = [];
    const label = (id: string) => (qualified ? code(qualifiedOf(id, sym.get(id)?.name ?? id)) : name(id));
    for (const p of paths) {
      const last = p.edges[p.edges.length - 1] as ImpactEdge;
      const first = p.edges[0] as ImpactEdge;
      const via = p.edges.length === 2 ? `, which ${VERB[first.kind] ?? "calls"} ${label(p.seed)} (2 hops` : " (1 hop";
      const verb = VERB[last.kind] ?? "calls";
      const inner = p.edges.length === 2 ? [...first.sites].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0] ?? null : null;
      for (const raw of last.sites) {
        const site = throughStep(raw, inner);
        rows.push({ tier: site.tier === "certain" ? 0 : site.tier === "likely" ? 1 : 2, text: `- ${path(site.file)}:${site.line} in ${name(last.from)} ${verb} ${label(last.to)}${via}, ${siteTier(site)})` });
      }
    }
    return rows.sort((a, b) => a.tier - b.tier);
  };
  if (impact.callers.length > 0) {
    out.push("", "Call sites of the touched and removed code, certain first:");
    const rows = rowsOf(impact.callers, false);
    for (const r of rows.slice(0, INLINE_SITES)) out.push(r.text);
    if (rows.length > INLINE_SITES) out.push(`- and ${n(rows.length - INLINE_SITES, "more call site")}${at("callers/", ", every one in")}`);
  } else {
    out.push("", impact.unknown.floor ? "No certain or likely caller of the touched code was found in the graph; the list is a floor (below), so callers may exist." : "No caller of the touched code was found in the graph.");
  }
  if (possible.length > 0) {
    out.push("", "Possible call sites, which may run the touched code and are not proved to (through an interface or a base type, or a function used as a value):");
    const rows = rowsOf(possible, true);
    for (const r of rows.slice(0, INLINE_POSSIBLE)) out.push(r.text);
    if (rows.length > INLINE_POSSIBLE) out.push(`- and ${n(rows.length - INLINE_POSSIBLE, "more possible call site")}${at("callers/", ", every one in")}`);
  }
  for (const h of impact.hubs) {
    out.push(`- ${name(h.symbol)} is a hub: called by ${n(h.callers, "symbol")} from ${n(h.sites, "site")} in ${n(h.files, "file")}; the 20 nearest callers are listed${at(`callers/${symbolKey(h.symbol)}.json`, ", the rest in")}.`);
  }
  for (const c of impact.cuts) {
    if (c.by === "second-hop") out.push(`- The second hop left out ${n(c.omitted ?? 0, "caller")} of ${name(c.at ?? "")}${at(`second-hop/${symbolKey(c.at ?? "")}.json`, "; every one is in")}.`);
    if (c.by === "walk-limit") out.push(`- ${prose(c.note)}.`);
    if (c.by === "hub" && c.note.includes("possible callers")) out.push(`- ${name(c.at ?? "")} has ${prose(c.note)}${at(`callers/${symbolKey(c.at ?? "")}.json`, ", the rest in")}.`);
    if (c.by === "fan-out") out.push(`- ${prose(`${c.note.charAt(0).toUpperCase()}${c.note.slice(1)}`)} (the fan-out cap).`);
  }

  // Other uses of the touched code: as a value, as a type, implemented or overridden.
  const refs = impact.references ?? [];
  if (refs.length > 0) {
    out.push("", "Other uses of the touched and removed code, not calls:");
    const ORDER: Record<string, number> = { overrides: 0, uses_value: 1, uses_type: 2 };
    const rows = [...refs]
      .flatMap((r) => r.edge.sites.map((s) => ({ r, s })))
      .sort((a, b) => (ORDER[a.r.edge.kind] ?? 3) - (ORDER[b.r.edge.kind] ?? 3) || TIER_RANK[b.s.tier] - TIER_RANK[a.s.tier] || a.s.file.localeCompare(b.s.file) || a.s.line - b.s.line);
    for (const { r, s } of rows.slice(0, MAX_REFERENCES)) {
      const from = code(qualifiedOf(r.edge.from, sym.get(r.edge.from)?.name ?? r.edge.from));
      const to = code(qualifiedOf(r.seed, sym.get(r.seed)?.name ?? r.seed));
      const what = r.edge.kind === "overrides" ? `${from} overrides or implements ${to}` : r.edge.kind === "uses_value" ? `in ${name(r.edge.from)} uses ${to} as a value` : `in ${name(r.edge.from)} names ${to} as a type`;
      out.push(`- ${path(s.file)}:${s.line} ${what} (${siteTier(s)})`);
    }
    const seeds = [...new Set(refs.map((r) => r.seed))];
    const pages = seeds.length === 1 ? at(`references/${symbolKey(seeds[0] as string)}.json`, ", every one in") : at("references/", ", every one in");
    if (rows.length > MAX_REFERENCES) out.push(`- and ${n(rows.length - MAX_REFERENCES, "more use")}${pages}`);
    for (const c of impact.cuts) if (c.by === "references") out.push(`- ${prose(c.note)}.`);
  }

  if (impact.callees.length > 0) {
    out.push("", "Called by the touched code:");
    const seen = new Set<string>();
    for (const p of impact.callees) {
      const e = p.edges[0] as ImpactEdge;
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      if (seen.size > MAX_CALLEES) continue;
      const s = sym.get(e.to);
      if (s) out.push(`- ${where(s)} ${code(s.name)} (${s.kind})`);
    }
    if (seen.size > MAX_CALLEES) out.push(`- and ${seen.size - MAX_CALLEES} more`);
  }
  pushImporters(out, impact, at);
  out.push(...renderFrameworkLines(impact.frameworks, packet));

  // 9. What the graph could not see near the change.
  const floors = impact.unknown.seeds.filter((s) => s.floor);
  const near = impact.unknown.near;
  if (floors.length > 0 || near.length > 0 || impact.unknown.notReadTotal > 0) {
    out.push("", "What the graph could not see:");
    for (const s of floors.slice(0, MAX_FLOOR_SEEDS)) out.push(`- The callers of ${name(s.seed)} are a floor: ${prose(s.reasons.join("; "))}.`);
    if (floors.length > MAX_FLOOR_SEEDS) out.push(`- and ${floors.length - MAX_FLOOR_SEEDS} more symbols with a floor`);
    const byCause = Object.entries(impact.unknown.causes)
      .filter(([, v]) => v !== null && v > 0)
      .map(([k, v]) => `${v} ${k}`);
    if (byCause.length > 0) out.push(`- In the changed files and their callers' files, ${n(impact.unknown.nearTotal, "call site")} could not be bound to one definition (${byCause.join(", ")}):`);
    for (const u of near.slice(0, MAX_NEAR)) {
      const at = u.file && u.line ? `${path(u.file)}:${u.line}` : u.file ? path(u.file) : "the repository";
      out.push(`  - ${at}${u.name ? ` ${code(u.name)}` : ""}: ${u.cause}${u.note ? `, ${prose(u.note)}` : ""}`);
    }
    if (impact.unknown.nearTotal > MAX_NEAR) out.push(`  - and ${impact.unknown.nearTotal - MAX_NEAR} more${at("unknowns.json")}`);
    if (impact.unknown.notReadTotal > 0) {
      const sample = impact.unknown.notRead.slice(0, 5).map((f) => `${path(f.file)} (${f.reason})`);
      out.push(`- ${n(impact.unknown.notReadTotal, "eligible file")} ${impact.unknown.notReadTotal === 1 ? "was" : "were"} not read: ${sample.join(", ")}${impact.unknown.notReadTotal > sample.length ? ", ..." : ""}`);
    }
  }
  return out.join("\n");
}

function pushImporters(out: string[], impact: ImpactSummary, at: (rel: string) => string): void {
  if (impact.importers.length === 0) return;
  out.push("", "Files that import a changed file:");
  for (const e of impact.importers.slice(0, MAX_IMPORTERS)) {
    const site = e.sites[0];
    const to = e.to.startsWith("go:") ? `package ${path(e.to.slice(3))}` : path(e.to);
    out.push(`- ${site ? `${path(site.file)}:${site.line}` : path(e.from)} imports ${to}${site && site.tier !== "certain" ? ` (${siteTier(site)})` : ""}`);
  }
  if (impact.importers.length > MAX_IMPORTERS) out.push(`- and ${impact.importers.length - MAX_IMPORTERS} more${at("importers/")}`);
}
