import { redactSecrets } from "@openqodex/core";
import type { ChangedFile, HunkRef } from "@openqodex/core";

export type Digest = { text: string; kind: "json" | "store"; processed: HunkRef[]; omitted: { path: string; lines: [number, number]; why: string }[] };
export type StoreFile = { path: string; text: string | null; status: ChangedFile["status"]; changed: HunkRef[]; bytes?: number };
type Node = { path: string; type: string; value: unknown; line: number; keyLine?: number; end: number; children: Node[]; raw: string };

// Segment pairs are intentional: .cargo/other and .yarn/caches are not stores.
export function storeRoot(path: string): string | null {
  const segments = path.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    const one = segments[i]!;
    const pair = `${one}/${segments[i + 1]}`;
    const length = ["node_modules", ".pnpm-store", ".pnpm", "site-packages"].includes(one) ? 1
      : [".yarn/cache", ".cargo/registry", ".m2/repository"].includes(pair) && i + 2 < segments.length ? 2 : 0;
    if (length) return segments.slice(0, i + length).join("/");
  }
  return null;
}

export function recognise(path: string, text: string): "json" | "store" | null {
  if (storeRoot(path)) return "store";
  try { positions(text); return "json"; } catch { return null; }
}

// JSON.parse validates the grammar. This separate tokenizer follows source
// positions, including escaped newlines and keys, rather than reserialising.
function positions(text: string): Node {
  JSON.parse(text);
  let at = 0;
  let line = 1;
  const skip = () => { while (/\s/.test(text[at] ?? "") && at < text.length) { if (text[at] === "\n") line++; at++; } };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === "\\") at++;
      else if (c === '"') break;
    }
    return JSON.parse(text.slice(start, at)) as string;
  };
  const parse = (path: string): Node => {
    skip();
    const first = line;
    const start = at;
    const children: Node[] = [];
    let value: unknown;
    let type: string;
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{";
      type = object ? "object" : "array";
      const close = object ? "}" : "]";
      skip();
      let index = 0;
      while (text[at] !== close) {
        let childPath = `${path}[${index++}]`;
        const keyLine = line;
        if (object) {
          const key = string();
          skip();
          at++;
          childPath = /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
        }
        const child = parse(childPath);
        if (object) child.keyLine = keyLine;
        children.push(child);
        skip();
        if (text[at] === ",") { at++; skip(); } else break;
      }
      at++;
      value = JSON.parse(text.slice(start, at));
    } else if (text[at] === '"') { type = "string"; value = string(); }
    else {
      while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++;
      value = JSON.parse(text.slice(start, at));
      type = value === null ? "null" : typeof value;
    }
    return { path, type, value, line: first, end: line, children, raw: text.slice(start, at) };
  };
  return parse("$");
}
const walk = (root: Node): Node[] => {
  const out: Node[] = [];
  const visit = (node: Node) => { out.push(node); node.children.forEach(visit); };
  visit(root);
  return out;
};
const family = (path: string) => path.replace(/\[\d+\]/g, ".[]");
const encoded = (value: unknown) => JSON.stringify(value);
const depth = (node: Node): number => node.children.length ? 1 + node.children.reduce((n, child) => Math.max(n, depth(child)), 0) : 0;
const extrema = (values: number[]) => values.reduce((span, n) => ({ min: Math.min(span.min, n), max: Math.max(span.max, n) }), { min: Infinity, max: -Infinity });
// Merge once so each node tests changed spans in logarithmic time.
function changedNodes(changed: HunkRef[]): (node: Node) => boolean {
  const ranges: [number, number][] = [];
  for (const h of changed.filter((h) => !h.deletion).sort((a, b) => a.start - b.start)) {
    const last = ranges.at(-1);
    if (last && h.start <= last[1] + 1) last[1] = Math.max(last[1], h.end);
    else ranges.push([h.start, h.end]);
  }
  return (node) => {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (ranges[mid]![1] < (node.keyLine ?? node.line)) low = mid + 1; else high = mid;
    }
    return low < ranges.length && ranges[low]![0] <= node.end;
  };
}

// A keyed map is one family. Source paths remain intact on value entries.
function families(roots: Node[]): Map<Node, string> {
  const out = new Map<Node, string>();
  const visit = (nodes: Node[], path: string) => {
    const children = new Map<string, Node[]>();
    // Decide once for both sides. Distinct keys identify a keyed object;
    // record shapes can change without changing its family identity.
    const keyed = nodes.every((node) => node.type === "object" && node.children.every((child) => child.type === "object")
      && new Set(node.children.map((child) => child.path)).size === node.children.length)
      && nodes.some((node) => node.children.length > 1);
    for (const node of nodes) {
      out.set(node, path);
      for (const child of node.children) append(children, keyed ? `${path}[*]` : path + family(child.path.slice(node.path.length)), child);
    }
    for (const [childPath, list] of children) visit(list, childPath);
  };
  visit(roots, "$");
  return out;
}

export type JsonEntry = { lines: [number, number]; text: string };
export type JsonSections = { fixed: string; entries: JsonEntry[]; omitted: Digest["omitted"] };
function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

// Redact decoded strings before encoding or shortening them. Source escapes
// must not turn a scanner's whole-secret match into a visible prefix.
export function jsonSections(path: string, text: string, changed: HunkRef[], previousText?: string, secrets: string[] = [], oldUnavailable = false): JsonSections {
  changed = changed.filter((h) => h.path === path);
  const changedNode = changedNodes(changed);
  secrets = [...new Set(secrets.flatMap((secret) => {
    try { return [secret, JSON.parse('"' + secret + '"') as string]; } catch { return [secret]; }
  }))];
  const root = positions(text);
  const nodes = walk(root);
  const oldRoot = previousText === undefined ? undefined : positions(previousText);
  const old = oldRoot ? walk(oldRoot) : [];
  const paths = families(oldRoot ? [root, oldRoot] : [root]);
  const familyOf = (node: Node) => paths.get(node)!;
  const safe = (value: unknown): unknown => {
    if (typeof value === "string") return redactSecrets(value, secrets);
    if (Array.isArray(value)) return value.map(safe);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactSecrets(k, secrets), safe(v)]));
    return value;
  };
  const encode = (value: unknown) => encoded(safe(value));
  const keys = root.type === "object" ? Object.keys(root.value as object) : [];
  const fixed = [`Top-level shape: ${root.type}${root.type === "array" ? ` length ${root.children.length}` : root.type === "object" ? ` keys ${encode(keys.slice(0, 50))}${keys.length > 50 ? ` (${keys.length} keys; first 50)` : ""}` : ""}; depth ${depth(root)}`, "Equal records are matched by content first; unmatched records are compared by index."];
  const entries: JsonEntry[] = [];
  const entry = (node: Node, text: string) => entries.push({ lines: [node.keyLine ?? node.line, node.end], text });
  const omitted: Digest["omitted"] = oldUnavailable ? changed.map((h) => ({ path, lines: [h.start, h.end], why: "old side unavailable" })) : [];
  const long = new Map<string, Node[]>();
  for (const node of nodes) {
    if (node.type === "array" || node.type === "object" || !changedNode(node)) continue;
    const value = node.type === "number" ? node.raw : encode(node.value);
    const length = typeof node.value === "string" ? Array.from(node.value).length : value.length;
    if (length < 200) entry(node, `${node.path}@${node.line} = ${value}`);
    else {
      append(long, familyOf(node), node);
      omitted.push({ path, lines: [node.line, node.end], why: `${node.path}: value grouped; first 120 characters shown of ${length}` });
    }
  }
  fixed.push(`Long-value families: ${long.size} (first 50)`);
  let longIndex = 0;
  for (const [key, list] of long) {
    const lengths = list.map((n) => typeof n.value === "string" ? Array.from(n.value).length : encoded(n.value).length);
    const span = extrema(lengths);
    if (longIndex++ < 50) fixed.push(`long values ${key}: count ${list.length}, length ${span.min}-${span.max} (JSON characters); first 120 characters of each:`);
    for (const node of list) entry(node, `${node.path}@${node.line} = ${typeof node.value === "string" ? encoded(Array.from(safe(node.value) as string).slice(0, 120).join("")) : redactSecrets(node.raw, secrets).slice(0, 120)}`);
  }
  for (const node of nodes) if (node.type === "string" && Array.from(node.value as string).length > 2000) entry(node, `string over 2000 characters: ${node.path}@${node.line}, length ${Array.from(node.value as string).length}`);
  const oldByPath = new Map(old.map((n) => [n.path, n]));
  const records = new Map<string, { next: Node[]; before: Node[] }>();
  for (const [side, list] of [["next", nodes], ["before", old]] as const) for (const node of list) {
    if (node.type !== "object") continue;
    const key = familyOf(node);
    if (!records.has(key)) records.set(key, { next: [], before: [] });
    records.get(key)![side].push(node);
  }
  fixed.push(`Record families: ${records.size} (first 50)`);
  let recordIndex = 0;
  const shapeRows: string[] = [];
  let shapeCount = 0;
  const paired = new Map<string, Node | null>();
  for (const [key, group] of records) {
    const byContent = new Map<string, Node[]>();
    for (const node of group.before) append(byContent, encoded(node.value), node);
    const used = new Set<Node>();
    const remaining: Node[] = [];
    for (const node of group.next) {
      const match = byContent.get(encoded(node.value))?.pop();
      if (match) { paired.set(node.path, match); used.add(match); }
      else remaining.push(node);
    }
    const byIndex = new Map(group.before.filter((n) => !used.has(n)).map((n) => [n.path, n]));
    let added = 0;
    let modified = 0;
    for (const node of remaining) {
      const match = byIndex.get(node.path);
      paired.set(node.path, match ?? null);
      if (match) used.add(match);
      if (!changedNode(node)) continue;
      if (match) modified++; else added++;
    }
    const removed = group.before.length - used.size;
    if (recordIndex++ < 50) fixed.push(`records ${key}: added ${oldUnavailable ? "unknown" : added}, removed ${oldUnavailable ? "unknown" : removed}, changed ${oldUnavailable ? "unknown" : modified}; total ${group.next.length}`);
    const shapes = new Map<string, Node[]>();
    for (const node of group.next) append(shapes, encoded(Object.keys(node.value as object).sort()), node);
    const counts = [...shapes.values()].map((list) => list.length).sort((a, b) => b - a);
    for (const [shape, list] of shapes) {
      shapeCount++;
      if (shapeRows.length < 50) {
        const keys = JSON.parse(shape) as string[];
        shapeRows.push(`shape ${key} ${encode(keys.slice(0, 50))}${keys.length > 50 ? ` (${keys.length} keys; first 50)` : ""}: count ${list.length}`);
      }
      if (shapes.size === 1 || list.length === counts[0] && list.length > (counts[1] ?? 0)) continue;
      for (const node of list) {
        const raw = Buffer.from(encode(node.value), "utf8");
        entry(node, `odd record ${node.path}@${node.line}-${node.end}: ${raw.subarray(0, 2048).toString("utf8")}`);
        if (raw.length > 2048) omitted.push({ path, lines: [node.line, node.end], why: `${node.path}: odd record text after 2 KB; scalars are listed separately` });
      }
    }
  }
  fixed.push(`Record shapes: ${shapeCount} (first 50)`, ...shapeRows);
  // Match descendant values through their record, so moving an equal record
  // cannot manufacture type changes at its former array index.
  const compare = (node: Node, record: Node | undefined) => {
    const owner = node.type === "object" ? node : record;
    const beforeRecord = owner ? paired.get(owner.path) : undefined;
    const before = owner ? beforeRecord ? oldByPath.get(beforeRecord.path + node.path.slice(owner.path.length)) : undefined : oldByPath.get(node.path);
    if (before && before.type !== node.type && changedNode(node)) entry(node, `type change ${node.path}@${node.line}: ${before.type} -> ${node.type}`);
    for (const child of node.children) compare(child, owner);
  };
  compare(root, undefined);
  const numbers = new Map<string, Node[]>();
  for (const node of nodes) if (node.type === "number" && Number.isFinite(node.value)) append(numbers, familyOf(node), node);
  fixed.push(`Numeric families: ${[...numbers.values()].filter((list) => list.length >= 10).length} (first 50)`);
  let numericIndex = 0;
  for (const [key, list] of numbers) {
    if (list.length < 10) continue;
    const values = list.map((n) => n.value as number);
    const scale = Math.max(1, extrema(values.map(Math.abs)).max);
    const mean = values.reduce((sum, n) => sum + n / scale, 0) / values.length;
    const sd = Math.sqrt(values.reduce((sum, n) => sum + (n / scale - mean) ** 2, 0) / values.length);
    const span = extrema(values);
    if (numericIndex++ < 50) fixed.push(`numeric ${key}: count ${list.length}, min ${span.min}, max ${span.max}`);
    for (const node of list) if (Math.abs((node.value as number) / scale - mean) > 3 * sd) entry(node, `outlier ${node.path}@${node.line} = ${node.value}`);
  }
  entries.sort((a, b) => a.lines[0] - b.lines[0] || b.lines[1] - a.lines[1]);
  return { fixed: redactSecrets(fixed.join("\n"), secrets), entries: entries.map((e) => ({ ...e, text: redactSecrets(e.text, secrets) })), omitted };
}

export function jsonDigest(path: string, text: string, changed: HunkRef[], previousText?: string, secrets: string[] = [], oldUnavailable = false): Digest {
  const sections = jsonSections(path, text, changed, previousText, secrets, oldUnavailable);
  return { kind: "json", text: [sections.fixed, ...sections.entries.map((e) => e.text), "Changed ranges:", ...changed.map((h) => `${h.path}:${h.start}-${h.end}${h.deletion ? ` removed ${h.old?.join("-") ?? ""}` : ""}`)].join("\n"), processed: changed.filter((h) => h.path === path), omitted: sections.omitted };
}

function sniff(text: string | null): string {
  if (text === null || text.includes("\0")) return "binary";
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && value.version === 3 && ("mappings" in value || "sections" in value) ? "source map" : "JSON";
  } catch { /* Code and licence text are expected not to parse as JSON. */ }
  return /\b(?:function\s*\w*\s*\(|(?:const|let|var|import|export|class|def|package|fn)\s+\w|module\.exports\s*=)/.test(text) ? "JavaScript or other code" : "text";
}
function manifest(file: StoreFile): string | null {
  const text = file.text;
  if (text === null) return null;
  const name = file.path.split("/").at(-1)!;
  if (name === "package.json") {
    try { const value = JSON.parse(text); return typeof value.name === "string" && typeof value.version === "string" ? `${value.name} ${value.version}` : null; } catch { return null; }
  }
  if (name === "PKG-INFO" || name === "METADATA") {
    const pkg = /^Name:\s*(.+)$/m.exec(text)?.[1];
    const version = /^Version:\s*(.+)$/m.exec(text)?.[1];
    return pkg && version ? `${pkg.trim()} ${version.trim()}` : null;
  }
  if (name === "Cargo.toml") {
    const section = /(?:^|\n)\[package\]\s*\n([\s\S]*?)(?=\n\[|$)/.exec(text)?.[1] ?? "";
    const pkg = /^name\s*=\s*["']([^"']+)["']/m.exec(section)?.[1];
    const version = /^version\s*=\s*["']([^"']+)["']/m.exec(section)?.[1];
    return pkg && version ? `${pkg} ${version}` : null;
  }
  if (name.endsWith(".pom")) {
    const pkg = /<artifactId>\s*([^<]+)<\/artifactId>/.exec(text)?.[1] ?? /<name>\s*([^<]+)<\/name>/.exec(text)?.[1];
    const version = /<version>\s*([^<]+)<\/version>/.exec(text)?.[1];
    return pkg && version ? `${pkg.trim()} ${version.trim()}` : null;
  }
  return null;
}

// The caller repeats the root summary and paginates these file blocks by
// the size of the complete brief, crediting only a page's listed files.
export function storeSections(root: string, files: StoreFile[], secrets: string[] = []): { summary: string; entries: { file: StoreFile; text: string; omitted: Digest["omitted"] }[] } {
  const kinds = new Map<string, number>();
  const sizes = files.map((file) => ({ file, bytes: file.bytes ?? Buffer.byteLength(file.text ?? "", "utf8"), lines: file.text === null || file.text === "" ? 0 : file.text.replace(/\n$/, "").split("\n").length }));
  for (const file of files) { const kind = file.status === "deleted" ? "deleted" : sniff(file.text); kinds.set(kind, (kinds.get(kind) ?? 0) + 1); }
  const out = [`Store root: ${root}`, `files added ${files.filter((f) => f.status === "added").length}, modified ${files.filter((f) => f.status === "modified" || f.status === "renamed").length}, deleted ${files.filter((f) => f.status === "deleted").length}`, `lines ${sizes.reduce((sum, f) => sum + f.lines, 0)}, bytes ${sizes.reduce((sum, f) => sum + f.bytes, 0)}`, `Kinds: ${[...kinds].map(([kind, n]) => `${kind}: ${n}`).join(", ")}`, "Manifests:"];
  const manifests = files.flatMap((file) => { const found = manifest(file); return found ? [`${file.path}: ${found}`] : []; });
  const generated = files.filter((file) => file.text !== null && /^(?:\s*(?:\/\/|\/\*|\*|#|<!--)\s*)?(?:@generated\b|Code generated\b|DO NOT EDIT\b|[Mm]inified\b)/.test(file.text.trimStart().split("\n").slice(0, 3).join("\n")));
  out[out.length - 1] = `Manifests: ${manifests.length} (first 50)`;
  for (const row of manifests.slice(0, 50)) out.push(row);
  out.push(`Generated/minified markers: ${generated.length} (first 50)`);
  for (const file of generated.slice(0, 50)) out.push(`generated/minified: ${file.path}`);
  out.push("Ten largest:");
  for (const f of [...sizes].sort((a, b) => b.bytes - a.bytes || a.file.path.localeCompare(b.file.path)).slice(0, 10)) out.push(`${f.file.path}: ${f.bytes} bytes, ${f.lines} lines`);
  out.push("File list:");
  const summary = redactSecrets(out.slice(0, -1).join("\n"), secrets);
  const generatedFiles = new Set(generated);
  const entries = sizes.map(({ file, lines }) => {
    const out: string[] = [];
    const omitted: Digest["omitted"] = [];
    const found = manifest(file);
    if (found) out.push(`manifest ${file.path}: ${found}`);
    if (generatedFiles.has(file)) out.push(`generated/minified: ${file.path}`);
    for (const row of file.changed.map((h) => `${file.path}:${h.start}-${h.end}${h.deletion ? ` removed ${h.old?.join("-") ?? ""}` : ""}`)) out.push(row);
    if (file.text !== null && !file.text.includes("\0") && lines < 30) out.push(`Complete text ${file.path}:`, file.text);
    else for (const h of file.changed) omitted.push({ path: file.path, lines: [h.start, h.end], why: file.text === null ? "binary or unavailable text; metadata and changed ranges only" : "file text grouped by content kind; inspect with tools" });
    return { file, text: redactSecrets(out.join("\n"), secrets), omitted };
  });
  return { summary, entries };
}

export function storeDigest(root: string, files: StoreFile[], secrets: string[] = []): Digest {
  const sections = storeSections(root, files, secrets);
  return {
    kind: "store", text: [sections.summary, "File list:", ...sections.entries.map((e) => e.text)].join("\n"),
    processed: files.flatMap((f) => f.changed), omitted: sections.entries.flatMap((e) => e.omitted),
  };
}
