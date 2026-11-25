import type { DefFact, FileFacts } from "../../types.js";
import { symbolId } from "../../resolve.js";
import { appId, MAX_ENTITIES_PER_APP } from "../plugin.js";
import type { Detection, FrameworkEvidence, FrameworkUnknown, PluginIndex, PluginOutput, Role } from "../plugin.js";
import type { JunitFact } from "./facts.js";
import { ANNOTATIONS, SIMPLE_NAMES } from "./annotations.js";

export const PLUGIN = "junit";
export const RULE = { id: "junit-annotation", version: 1 };
export const MAX_WORK = 200_000;
const MAX_HIERARCHY = 1000;

type Candidate = Extract<JunitFact, { kind: "annotation" }>;
type Via = FrameworkEvidence["via"];
type Binding = { name: string; via: Via };
type Identity = { kind: "junit"; name: string; role: Role; via: Via; tier: "certain" | "likely"; note: string | null } | { kind: "other" | "ambiguous" | "cap" };
type JavaFile = { facts: FileFacts; project: string; pkg: string; types: Map<string, TypeInfo>; explicit: Map<string, Binding[]>; stars: Binding[] };
type TypeInfo = { file: string; path: string; full: string; def: DefFact };
type Analysis = { apps: Detection[]; output: PluginOutput };
const cached = new WeakMap<PluginIndex<JunitFact>, Analysis>();
const qualified = (pkg: string, name: string): string => (pkg ? `${pkg}.${name}` : name);

export function analyse(index: PluginIndex<JunitFact>): Analysis {
  const saved = cached.get(index);
  if (saved) return saved;
  const output: PluginOutput = { roles: [], entities: [], edges: [], unknowns: [] };
  const result: Analysis = { apps: [], output };
  cached.set(index, result);
  // Repository-wide indexing is linear. Only repeated lookup work spends the resolution budget.
  if (index.factFiles().length === 0) return result;
  const files = new Map<string, JavaFile>();
  const types = new Map<string, TypeInfo[]>();
  const byId = new Map<string, TypeInfo>();
  const packages = new Set<string>();
  let work = 0;
  let capped = false;
  const gap = (cause: FrameworkUnknown["cause"], file: string | null, line: number, column: number, name: string | null, note: string): void => {
    output.unknowns.push({ plugin: PLUGIN, site: file ? { file, line, column } : null, scope: file ? { file } : { build: true }, affects: ["tests"], cause, name, note, count: null, exact: false });
  };
  const step = (): boolean => {
    if (++work <= MAX_WORK) return true;
    if (!capped) gap("fan-out-capped", null, 1, 1, null, "JUnit resolution stopped at its work limit.");
    capped = true;
    return false;
  };
  for (const file of index.paths()) {
    if (!file.endsWith(".java")) continue;
    const facts = index.languageFacts(file);
    if (!facts || facts.lang !== "java") continue;
    const project = index.projectOf(file);
    const pkg = facts.javaPackage ?? "";
    const env: JavaFile = { facts, project, pkg, types: new Map(), explicit: new Map(), stars: [] };
    files.set(file, env);
    packages.add(pkg);
    for (const def of facts.defs) {
      if (def.kind !== "class") continue;
      const path = qualified(def.owner ?? "", def.name);
      const full = qualified(pkg, path);
      const info: TypeInfo = { file, path, full, def };
      env.types.set(path, info);
      byId.set(symbolId(file, def), info);
      const list = types.get(full) ?? [];
      list.push(info);
      types.set(full, list);
    }
    for (const imp of facts.imports) {
      if (imp.staticStar) continue;
      const via = (name: string): Via => ({ file, line: imp.line, spec: name });
      if (imp.star) {
        env.stars.push({ name: imp.spec, via: via(`${imp.spec}.*`) });
        continue;
      }
      for (const n of imp.names) {
        const full = qualified(imp.spec, n.imported);
        const local = imp.staticMember ?? n.local;
        const name = imp.staticMember ? qualified(full, imp.staticMember) : full;
        const list = env.explicit.get(local) ?? [];
        list.push({ name, via: via(name) });
        env.explicit.set(local, list);
      }
    }
  }
  const repositoryType = (full: string): TypeInfo[] => types.get(full) ?? [];
  const baseCache = new Map<TypeInfo, { types: TypeInfo[]; unresolved: string[] }>();
  const bases = (info: TypeInfo): { types: TypeInfo[]; unresolved: string[] } => {
    const saved = baseCache.get(info);
    if (saved) return saved;
    const out: { types: TypeInfo[]; unresolved: string[] } = { types: [], unresolved: [] };
    baseCache.set(info, out);
    for (const base of info.def.bases) {
      if (!step()) break;
      const hit = index.lookup(info.file, [...(base.qualifier?.split(".") ?? []), base.name]);
      let unresolved = hit.kind !== "symbol" || hit.ids.length === 0;
      if (hit.kind === "symbol") for (const id of hit.ids) {
        if (!step()) break;
        const type = byId.get(id);
        if (type) out.types.push(type);
        else unresolved = true;
      }
      if (unresolved) out.unresolved.push(qualified(base.qualifier ?? "", base.name));
    }
    return out;
  };
  const inherited = (type: TypeInfo, name: string, unresolved: Set<string>): "found" | "none" | "cap" => {
    const first = bases(type);
    for (const name of first.unresolved) unresolved.add(name);
    const queue = [...first.types];
    const seen = new Set<TypeInfo>();
    for (let at = 0; at < queue.length; at++) {
      if (!step() || at >= MAX_HIERARCHY) return "cap";
      const current = queue[at] as TypeInfo;
      if (seen.has(current)) continue;
      seen.add(current);
      if (repositoryType(qualified(current.full, name)).length > 0) return "found";
      const parents = bases(current);
      for (const name of parents.unresolved) unresolved.add(name);
      for (const parent of parents.types) queue.push(parent);
    }
    return capped ? "cap" : "none";
  };
  const bindCache = new Map<string, Identity>();
  const identity = (file: string, fact: Candidate): Identity => {
    const env = files.get(file);
    if (!env) return { kind: "other" };
    const cacheKey = `${file}\0${fact.owner}\0${fact.name}`;
    const saved = bindCache.get(cacheKey);
    if (saved) return saved;
    const decide = (): Identity => {
      const parts = fact.name.split(".");
      const head = parts[0] as string;
      const unresolved = new Set<string>();
      // Enclosing declarations and inherited nested types precede imports.
      const owners = fact.owner.split(".");
      for (let n = owners.length; n > 0; n--) {
        if (!step()) return { kind: "cap" };
        const path = owners.slice(0, n).join(".");
        const owner = env.types.get(path);
        if (!owner) continue;
        if (owner.def.name === head || env.types.has(qualified(path, head))) return { kind: "other" };
        const hit = inherited(owner, head, unresolved);
        if (hit === "cap") return { kind: "cap" };
        if (hit === "found") return { kind: "other" };
      }
      const classify = (name: string, via: Via): Identity => {
        if (repositoryType(name).length > 0) return { kind: "other" };
        const role = ANNOTATIONS.get(name);
        if (!role) return { kind: "other" };
        const note = unresolved.size > 0 ? `An unresolved base may also supply ${head}: ${[...unresolved].sort().join(", ")}.` : null;
        return { kind: "junit", name, role, via, tier: note ? "likely" : "certain", note };
      };
      const explicit = env.explicit.get(head);
      if (explicit) {
        const names = new Map(explicit.map((b) => [b.name, b]));
        if (names.size !== 1) return { kind: "ambiguous" };
        const binding = explicit[0] as Binding;
        return classify([...binding.name.split("."), ...parts.slice(1)].join("."), binding.via);
      }
      if (repositoryType(qualified(env.pkg, head)).length > 0) return { kind: "other" };
      if (parts.length > 1) return classify(fact.name, null);
      const possible = new Map<string, { identity: Identity; unresolved: boolean; star: string }>();
      for (const star of env.stars) {
        if (!step()) return { kind: "cap" };
        if (star.name === "java" || star.name === "javax" || star.name.startsWith("java.") || star.name.startsWith("javax.")) continue;
        const full = qualified(star.name, head);
        const found = classify(full, star.via);
        const repo = repositoryType(full).length > 0;
        const closed = packages.has(star.name) || repositoryType(star.name).length > 0;
        if (repo || found.kind === "junit" || !closed) possible.set(full, { identity: found, unresolved: !repo && found.kind !== "junit", star: `${star.name}.*` });
      }
      const matches = [...possible.values()];
      const proven = matches.filter((b) => b.identity.kind === "junit");
      const junit = proven[0]?.identity;
      if (!junit || junit.kind !== "junit") return { kind: "other" };
      if (matches.length === 1) return junit;
      const competing = matches.filter((b) => b.identity.kind !== "junit");
      if (proven.length !== 1 || competing.some((b) => !b.unresolved)) return { kind: "ambiguous" };
      const imports = competing.map((b) => b.star).sort().join(", ");
      const note = [junit.note, `Unresolved star imports may also supply ${head}: ${imports}.`].filter(Boolean).join(" ");
      return { ...junit, tier: "likely", note };
    };
    const found = decide();
    bindCache.set(cacheKey, found);
    return found;
  };
  const apps = new Map<string, Detection>();
  const seen = new Set<string>();
  const rolesPerProject = new Map<string, number>();
  const cappedProjects = new Set<string>();
  for (const file of index.factFiles()) {
    if (capped) break;
    const env = files.get(file);
    if (!env || cappedProjects.has(env.project)) continue;
    for (const fact of index.factsOf(file)) {
      if (fact.kind === "cap") {
        gap("fan-out-capped", file, fact.line, fact.column, null, "JUnit annotation reading stopped at its limit.");
        continue;
      }
      if (fact.kind === "parse-error") {
        gap("file-not-parsed", file, fact.line, fact.column, null, "JUnit annotations in a broken region were not read.");
        continue;
      }
      if (!SIMPLE_NAMES.has(fact.name.slice(fact.name.lastIndexOf(".") + 1))) continue;
      const target = symbolId(file, { ...fact.method, owner: fact.owner });
      if (index.node(target)?.kind !== "method") continue;
      const binding = identity(file, fact);
      if (binding.kind === "cap") {
        if (!capped) gap("fan-out-capped", file, fact.line, fact.column, fact.name, "JUnit type lookup stopped at its inheritance limit.");
        continue;
      }
      if (binding.kind === "ambiguous") {
        gap("ambiguous", file, fact.line, fact.column, fact.name, "Competing imports prevent a unique annotation identity.");
        continue;
      }
      if (binding.kind !== "junit") continue;
      const roleKey = `${target}\0${binding.role}`;
      if (seen.has(roleKey)) continue;
      let app = apps.get(env.project);
      if (!app) {
        app = { id: appId(PLUGIN, file, fact.line), name: env.project || "JUnit", project: env.project, root: env.project, site: { file, line: fact.line, column: fact.column }, evidence: [{ file, line: fact.line, note: "A JUnit annotation proves this application." }], version: null };
        apps.set(env.project, app);
        result.apps.push(app);
      }
      const count = rolesPerProject.get(env.project) ?? 0;
      if (count >= MAX_ENTITIES_PER_APP) {
        output.unknowns.push({ plugin: PLUGIN, site: null, scope: { app: app.id }, affects: ["tests"], cause: "fan-out-capped", name: null, note: "JUnit role listing stopped at this application's limit.", count: null, exact: false });
        cappedProjects.add(env.project);
        break;
      }
      seen.add(roleKey);
      rolesPerProject.set(env.project, count + 1);
      output.roles.push({ target, role: binding.role, detail: binding.name, app: app.id, evidence: { kind: "role-decorator", tier: binding.tier, site: { file, line: fact.line, column: fact.column }, via: binding.via, premises: [], rule: RULE, note: binding.note } });
    }
  }
  return result;
}
