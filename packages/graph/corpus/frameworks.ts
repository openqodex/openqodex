// Scores a corpus case's `frameworks` section (frameworks/plugin.ts): the
// registrations, edges, roles and unknowns a plugin must produce, the kinds
// it must not produce (negative controls), and the lines the review brief
// must print. Every framework evidence record in the graph is checked in
// every case, framework or not.
//
// Endpoints in expected.json:
// - a symbol: `<file>#<name>` or `<file>#<Owner>.<name>`, as the rest of the corpus
// - a registration: `registration:<file>:<line>`
// - a template: `template:<path>` (the template's path as rendered, or its file)
// - another entity: `<kind>:<name>` (`command:publish`, `config_key:FEATURE_X`, `table:posts`)
// - a file: its path
import type { ImpactSummary } from "@openqodex/core";
import { renderImpactBlock, validateFrameworkEvidence } from "../src/index.js";
import type { Entity, FrameworkEdgeKind, Graph, HandlerStatus, Role, TestCategory, Tier } from "../src/index.js";

export type FrameworkExpected = {
  plugin: string;
  apps?: number; // the applications the plugin detects
  registrations?: { site: string; methods?: string[]; pattern?: string | null; name?: string | null; handler?: string | null; status?: HandlerStatus; mounted?: boolean }[];
  edges?: { kind: FrameworkEdgeKind; from: string; to: string; tier?: Tier; category?: TestCategory }[];
  roles?: { target: string; role: Role; detail?: string; tier?: Tier; note?: string }[];
  unknowns?: { file: string; line?: number; cause: string }[];
  notUnknowns?: { file: string; line: number; cause: string }[];
  partials?: { site: string; partial: string | null }[]; // the known part of a computed pattern
  maxUnknowns?: { file: string; cause: string; max: number }[]; // a gap said once, not once per site // gaps that must not be reported (a relation outside the repository is not a miss)
  // Kinds the plugin must emit none of: an edge kind, an entity kind, or
  // "role" for any role at all.
  none?: string[];
  // Roles and edges that must not exist (an unrelated same-name function bound as a handler).
  notRoles?: { target: string; role: Role }[];
  notEdges?: { kind: FrameworkEdgeKind; from?: string; to?: string }[];
  // Files that must hold no registration of the plugin (a file that looks like a route table and is not one).
  noRegistrationsIn?: string[];
  // Registration sites ("file:line") that must not be registered (a URL list the module replaced).
  notRegistrations?: string[];
  brief?: string[]; // substrings the review brief must print
  notBrief?: string[]; // substrings it must not print
};

export type Ratio = { hit: number; of: number };

export type FrameworkScore = { recall: Ratio; validity: Ratio; gaps: Ratio; controls: Ratio; failures: string[] };

const ratio = (): Ratio => ({ hit: 0, of: 0 });

export function scoreFrameworks(expected: FrameworkExpected | undefined, graph: Graph, impact: ImpactSummary, matches: (spec: string, id: string) => boolean): FrameworkScore {
  const out: FrameworkScore = { recall: ratio(), validity: ratio(), gaps: ratio(), controls: ratio(), failures: [] };
  const data = graph.frameworks;
  // Validity holds in every case.
  if (data) {
    for (const x of [...data.edges, ...data.roles]) {
      out.validity.of++;
      const why = validateFrameworkEvidence(x.evidence);
      if (why === null) out.validity.hit++;
      else out.failures.push(`invalid framework evidence at ${x.evidence.site.file}:${x.evidence.site.line} (${x.evidence.rule.id}): ${why}`);
    }
  }
  if (!expected) return out;
  if (!data) {
    out.failures.push("the graph has no framework data");
    return out;
  }
  const mine = {
    entities: data.entities.filter((e) => e.plugin === expected.plugin),
    edges: data.edges.filter((e) => e.plugin === expected.plugin),
    roles: data.roles.filter((r) => r.plugin === expected.plugin),
    unknowns: data.unknowns.filter((u) => u.plugin === expected.plugin),
  };
  const pluginRun = data.plugins.find((p) => p.id === expected.plugin);
  if (!pluginRun) out.failures.push(`the ${expected.plugin} plugin did not run`);
  else if (pluginRun.status === "failed") out.failures.push(`the ${expected.plugin} plugin failed: ${pluginRun.reason ?? ""}`);

  const entityMatches = (spec: string, e: Entity): boolean => {
    if (spec.startsWith("registration:")) return e.kind === "registration" && `registration:${e.site.file}:${e.site.line}` === spec;
    const colon = spec.indexOf(":");
    if (colon < 0 || e.kind === "registration") return false;
    const kind = spec.slice(0, colon);
    const name = spec.slice(colon + 1);
    return e.kind === kind && (e.name === name || e.file === name);
  };
  const endpoint = (spec: string, id: string): boolean => {
    if (spec.includes("#")) return matches(spec, id);
    const entity = data.entities.find((e) => e.id === id);
    if (entity) return entityMatches(spec, entity);
    return spec === id;
  };
  const show = (id: string): string => {
    const e = data.entities.find((x) => x.id === id);
    if (!e) return id;
    return e.kind === "registration" ? `registration:${e.site.file}:${e.site.line}` : `${e.kind}:${e.name}`;
  };

  if (expected.apps !== undefined) {
    out.recall.of++;
    const n = data.apps.filter((a) => a.plugin === expected.plugin).length;
    if (n === expected.apps) out.recall.hit++;
    else out.failures.push(`${n} ${expected.plugin} applications, expected ${expected.apps}`);
  }

  for (const r of expected.registrations ?? []) {
    out.recall.of++;
    const found = mine.entities.filter((e) => e.kind === "registration" && `${e.site.file}:${e.site.line}` === r.site);
    const reg = found.find((e) => e.kind === "registration" && (r.pattern === undefined || e.pattern === r.pattern));
    if (!reg || reg.kind !== "registration") {
      out.failures.push(found.length > 0 ? `registration at ${r.site} has pattern ${found.map((e) => (e.kind === "registration" ? JSON.stringify(e.pattern) : "")).join(", ")}, expected ${JSON.stringify(r.pattern)}` : `registration not found: ${r.site}`);
      continue;
    }
    const wrong: string[] = [];
    if (r.methods !== undefined && JSON.stringify([...reg.methods].sort()) !== JSON.stringify([...r.methods].sort())) wrong.push(`methods ${reg.methods.join(",")}, expected ${r.methods.join(",")}`);
    if (r.name !== undefined && reg.name !== r.name) wrong.push(`name ${JSON.stringify(reg.name)}, expected ${JSON.stringify(r.name)}`);
    if (r.status !== undefined && reg.handler.status !== r.status) wrong.push(`handler status ${reg.handler.status}, expected ${r.status}`);
    if (r.mounted !== undefined && reg.mounted !== r.mounted) wrong.push(`mounted ${reg.mounted}, expected ${r.mounted}`);
    if (r.handler !== undefined) {
      const handles = mine.edges.filter((e) => e.kind === "handles" && e.from === reg.id);
      if (r.handler === null ? handles.length > 0 : !handles.some((e) => matches(r.handler as string, e.to))) wrong.push(`handled by ${handles.map((e) => e.to).join(", ") || "nothing"}, expected ${r.handler ?? "nothing"}`);
    }
    if (wrong.length === 0) out.recall.hit++;
    else out.failures.push(`registration ${r.site}: ${wrong.join("; ")}`);
  }

  for (const x of expected.edges ?? []) {
    out.recall.of++;
    const found = mine.edges.filter((e) => e.kind === x.kind && endpoint(x.from, e.from) && endpoint(x.to, e.to));
    const ok = found.find((e) => (x.tier === undefined || e.evidence.tier === x.tier) && (x.category === undefined || e.category === x.category));
    if (ok) out.recall.hit++;
    else
      out.failures.push(
        found.length > 0
          ? `${x.kind} ${x.from} to ${x.to} is ${found.map((e) => `${e.evidence.tier}${e.category ? `/${e.category}` : ""}`).join(", ")}, expected ${x.tier ?? "any tier"}${x.category ? `/${x.category}` : ""}`
          : `edge not found: ${x.kind} ${x.from} to ${x.to} (${x.kind} edges: ${
              mine.edges
                .filter((e) => e.kind === x.kind)
                .slice(0, 6)
                .map((e) => `${show(e.from)} to ${show(e.to)}`)
                .join("; ") || "none"
            })`,
      );
  }

  for (const r of expected.roles ?? []) {
    out.recall.of++;
    const found = mine.roles.filter((x) => endpoint(r.target, x.target) && x.role === r.role);
    if (found.some((x) => r.detail === undefined || x.detail === r.detail)) out.recall.hit++;
    else out.failures.push(found.length > 0 ? `role ${r.role} on ${r.target} has detail ${found.map((x) => x.detail).join(", ")}, expected ${r.detail}` : `role not found: ${r.role} on ${r.target}`);
    if (r.tier !== undefined || r.note !== undefined) {
      out.recall.of++;
      if (found.some((x) => (r.detail === undefined || x.detail === r.detail) && (r.tier === undefined || x.evidence.tier === r.tier) && (r.note === undefined || x.evidence.note === r.note))) out.recall.hit++;
      else out.failures.push(`role evidence mismatch: ${r.role} on ${r.target}, expected ${r.tier ?? "any tier"}, ${r.note ?? "any note"}`);
    }
  }

  for (const u of expected.unknowns ?? []) {
    out.gaps.of++;
    const hit = mine.unknowns.some((x) => x.cause === u.cause && ((x.site !== null && x.site.file === u.file && (u.line === undefined || x.site.line === u.line)) || (u.line === undefined && "file" in x.scope && x.scope.file === u.file)));
    if (hit) out.gaps.hit++;
    else {
      const there = mine.unknowns.filter((x) => x.site?.file === u.file).map((x) => `${x.site?.line}:${x.cause}`);
      out.failures.push(`framework unknown not disclosed: ${u.file}${u.line !== undefined ? `:${u.line}` : ""} ${u.cause}${there.length > 0 ? ` (found ${there.join(", ")})` : ""}`);
    }
  }

  for (const kind of expected.none ?? []) {
    out.controls.of++;
    const bad =
      kind === "role"
        ? mine.roles.map((r) => `${r.role} on ${r.target}`)
        : [...mine.edges.filter((e) => e.kind === kind).map((e) => `${e.kind} ${show(e.from)} to ${show(e.to)}`), ...mine.entities.filter((e) => e.kind === kind).map((e) => show(e.id))];
    if (bad.length === 0) out.controls.hit++;
    else out.failures.push(`negative control broken: the ${expected.plugin} plugin emitted ${kind}: ${bad.slice(0, 4).join("; ")}`);
  }
  for (const x of expected.partials ?? []) {
    out.recall.of++;
    const reg = mine.entities.find((e) => e.kind === "registration" && `${e.site.file}:${e.site.line}` === x.site);
    const got = reg && reg.kind === "registration" ? (reg.partial ?? null) : undefined;
    if (got === x.partial) out.recall.hit++;
    else out.failures.push(`registration ${x.site} has partial ${JSON.stringify(got)}, expected ${JSON.stringify(x.partial)}`);
  }
  for (const x of expected.maxUnknowns ?? []) {
    out.controls.of++;
    const n = mine.unknowns.filter((u) => u.cause === x.cause && (u.site?.file === x.file || ("file" in u.scope && u.scope.file === x.file))).length;
    if (n <= x.max) out.controls.hit++;
    else out.failures.push(`${n} ${x.cause} gaps in ${x.file}, at most ${x.max} expected`);
  }
  for (const n of expected.notUnknowns ?? []) {
    out.controls.of++;
    const bad = mine.unknowns.filter((x) => x.cause === n.cause && x.site?.file === n.file && x.site.line === n.line);
    if (bad.length === 0) out.controls.hit++;
    else out.failures.push(`negative control broken: ${n.file}:${n.line} is reported as ${n.cause}: ${bad[0]?.note ?? ""}`);
  }
  for (const site of expected.notRegistrations ?? []) {
    out.controls.of++;
    const bad = mine.entities.filter((e) => e.kind === "registration" && `${e.site.file}:${e.site.line}` === site);
    if (bad.length === 0) out.controls.hit++;
    else out.failures.push(`negative control broken: ${site} is registered (${bad.length} registrations)`);
  }
  for (const file of expected.noRegistrationsIn ?? []) {
    out.controls.of++;
    const bad = mine.entities.filter((e) => e.kind === "registration" && e.site.file === file);
    if (bad.length === 0) out.controls.hit++;
    else out.failures.push(`negative control broken: ${bad.length} registrations in ${file}, which is not a route table`);
  }
  for (const n of expected.notRoles ?? []) {
    out.controls.of++;
    const bad = mine.roles.filter((r) => r.role === n.role && endpoint(n.target, r.target));
    if (bad.length === 0) out.controls.hit++;
    else out.failures.push(`negative control broken: ${n.role} role on ${n.target}`);
  }
  for (const n of expected.notEdges ?? []) {
    out.controls.of++;
    const bad = mine.edges.filter((e) => e.kind === n.kind && (n.from === undefined || endpoint(n.from, e.from)) && (n.to === undefined || endpoint(n.to, e.to)));
    if (bad.length === 0) out.controls.hit++;
    else out.failures.push(`negative control broken: ${bad.map((e) => `${e.kind} ${show(e.from)} to ${show(e.to)}`).join("; ")}`);
  }

  if ((expected.brief ?? []).length > 0 || (expected.notBrief ?? []).length > 0) {
    const brief = renderImpactBlock(impact);
    for (const line of expected.brief ?? []) {
      out.recall.of++;
      if (brief.includes(line)) out.recall.hit++;
      else out.failures.push(`the brief does not print ${JSON.stringify(line)}:\n${brief}`);
    }
    for (const line of expected.notBrief ?? []) {
      out.controls.of++;
      if (!brief.includes(line)) out.controls.hit++;
      else out.failures.push(`the brief prints ${JSON.stringify(line)}, which it must not`);
    }
  }
  return out;
}
