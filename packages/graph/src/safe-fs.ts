// Reads inside the repo that a hostile repo cannot redirect: no path
// component may be a symbolic link, files are opened without following
// links, and every read is bounded.
import { isAbsolute, resolve } from "node:path";
import { FolderReader, type EntryResult } from "@openqodex/core";
import { isFrameworkFileFacts } from "./frameworks/facts.js";
import type { FileFacts } from "./types.js";
import { MAX_TYPE_DEPTH } from "./types.js";

// Repo-relative reads, each decided by what the filesystem holds at the
// moment of that read and by nothing kept from an earlier one. The root is
// known by its identity (device and inode) from the moment the reader is
// made. Every read walks from it one name at a time, each folder a real
// folder (lstat: a link is not one), opens the file without following a
// link and without blocking, then walks again and requires the same
// folders by identity and the opened file at its name (FolderReader,
// packages/core/src/guarded-fs.ts). A folder swapped for a link after one
// read stops the next read.
export class RepoReader {
  // Null when the root is not a folder: every read then gives null.
  private readonly folders: FolderReader | null;

  constructor(readonly root: string) {
    let folders: FolderReader | null = null;
    try {
      folders = new FolderReader(resolve(root));
    } catch {
      // not a folder: nothing below it can be read
    }
    this.folders = folders;
  }

  read(rel: string, maxBytes: number): string | null {
    return this.readBytes(rel, maxBytes)?.toString("utf8") ?? null;
  }

  // The regular file `rel` (a path from the root, `/` between names) when
  // it holds at most `maxBytes`; null otherwise. An empty name, `.` or `..`
  // anywhere in it is refused.
  readBytes(rel: string, maxBytes: number): Buffer | null {
    if (this.folders === null || isAbsolute(rel)) return null;
    const got = this.folders.read(rel.split("/"), maxBytes);
    return got.ok ? got.data : null;
  }

  // What stands at `rel`, of any kind (the caller judges it): its lstat,
  // taken between two walks that find the same real folders by identity.
  // "refused" when a name on the way is not a real folder (a link, a file)
  // or the folders changed during the look; "missing" when nothing is there.
  entry(rel: string): EntryResult {
    if (this.folders === null || isAbsolute(rel)) return { ok: false, why: "refused" };
    return this.folders.entry(rel.split("/"));
  }
}

// ---------- the cached facts must match their schema exactly ----------

const MAX_ITEMS = 200_000;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length <= 4096;
const isInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= -1 && (v as number) <= 10_000_000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";
const isList = (v: unknown, each: (x: unknown) => boolean, max = MAX_ITEMS): boolean => Array.isArray(v) && v.length <= max && v.every(each);

// A scoped import binding: absent, or an import of this file by index.
function optBound(b: unknown, imports: number): boolean {
  return b === undefined || (isObj(b) && isInt(b.import) && (b.import as number) >= 0 && (b.import as number) < imports && isStr(b.imported));
}

const RELS = new Set(["implements", "include", "prepend", "extend"]);


function isTypeRef(v: unknown, imports: number, depth = 0): boolean {
  return (
    depth <= MAX_TYPE_DEPTH &&
    isObj(v) &&
    (v.on === undefined || isTypeRef(v.on, imports, depth + 1)) &&
    (v.args === undefined || (Array.isArray(v.args) && v.args.every((a: unknown) => isTypeRef(a, imports, depth + 1)))) &&
    (v.kind === undefined || v.kind === "param") &&
    (v.param === undefined || (isInt(v.param) && (v.param as number) >= 0)) &&
    isStr(v.name) &&
    (v.qualifier === null || isStr(v.qualifier)) &&
    isInt(v.line) &&
    isInt(v.column) &&
    (v.result === undefined || isInt(v.result)) &&
    optBool(v.elem) &&
    optBool(v.declared) &&
    optBool(v.promise) &&
    optBool(v.awaited) &&
    optBound(v.bound, imports) &&
    (v.rel === undefined || RELS.has(v.rel as string))
  );
}

// An index into a list of `size` items.
const isIndex = (v: unknown, size: number) => isInt(v) && (v as number) >= 0 && (v as number) < size;
const optIndex = (v: unknown, size: number) => v === undefined || isIndex(v, size);
const ROLES = new Set(["arg", "assign", "return", "property", "element"]);

function isReceiver(v: unknown, imports: number): boolean {
  if (!isObj(v)) return false;
  const path = (p: unknown) => isList(p, isStr, 64);
  switch (v.kind) {
    case "none":
    case "super":
    case "other":
      return true;
    case "self":
      return path(v.path);
    case "type":
      return isTypeRef(v.type, imports) && path(v.path);
    case "name":
      return isStr(v.name) && path(v.path) && (v.nesting === null || isStr(v.nesting)) && optBound(v.bound, imports);
    default:
      return false;
  }
}

const KINDS = new Set(["function", "method", "class", "module", "type"]);
const LANGS = new Set(["typescript", "tsx", "javascript", "python", "go", "ruby", "java"]);

function isDef(v: unknown, imports: number, values: number): boolean {
  const isType = (t: unknown) => isTypeRef(t, imports);
  const params = isObj(v) && Array.isArray(v.params) ? v.params.length : 0;
  return (
    isObj(v) &&
    isStr(v.name) &&
    KINDS.has(v.kind as string) &&
    (v.owner === null || isStr(v.owner)) &&
    isInt(v.line) &&
    isInt(v.column) &&
    isInt(v.endLine) &&
    typeof v.exported === "boolean" &&
    typeof v.topLevel === "boolean" &&
    isList(v.bases, isType, 1024) &&
    (v.dynamicBases === undefined || isList(v.dynamicBases, (b) => isObj(b) && isInt(b.line) && isInt(b.column) && (b.head === undefined || isType(b.head)) && (b.rel === undefined || b.rel === "include" || b.rel === "extend" || b.rel === "prepend"), 1024)) &&
    isObj(v.fields) &&
    Object.keys(v.fields).length <= 4096 &&
    Object.values(v.fields).every(isType) &&
    (v.results === undefined || isList(v.results, (r) => r === null || isType(r), 64)) &&
    (v.alias === undefined || isType(v.alias)) &&
    optBool(v.static) &&
    (v.bodyHash === undefined || (typeof v.bodyHash === "string" && /^[0-9a-f]{16}$/.test(v.bodyHash))) &&
    optBool(v.abstract) &&
    optBool(v.iface) &&
    optBool(v.anonymous) &&
    optBool(v.pointer) &&
    optBool(v.varargs) &&
    optBool(v.ctor) &&
    (v.params === undefined || isList(v.params, isStr, 256)) &&
    (v.invokes === undefined || isList(v.invokes, (i) => isIndex(i, params), 256)) &&
    (v.returns === undefined || isList(v.returns, (i) => isIndex(i, values), 256)) &&
    optBool(v.returnsOther)
  );
}

export function isFileFacts(v: unknown): v is FileFacts {
  if (!isObj(v) || !LANGS.has(v.lang as string)) return false;
  const imports = Array.isArray(v.imports) ? v.imports.length : 0;
  const values = Array.isArray(v.values) ? v.values.length : 0;
  const calls = Array.isArray(v.calls) ? v.calls.length : 0;
  const tables = Array.isArray(v.tables) ? v.tables.length : 0;
  if (!isList(v.defs, (d) => isDef(d, imports, values))) return false;
  const defs = (v.defs as unknown[]).length;
  const isCall = (c: unknown) =>
    isObj(c) &&
    isStr(c.name) &&
    isInt(c.line) &&
    isInt(c.column) &&
    isInt(c.caller) &&
    (c.caller as number) < defs &&
    isReceiver(c.recv, imports) &&
    optBool(c.implicit) &&
    optBool(c.shadowed) &&
    optBool(c.static) &&
    optBool(c.ctor) &&
    optBool(c.dynamic) &&
    (c.arity === undefined || (isInt(c.arity) && (c.arity as number) >= 0)) &&
    (c.local === undefined || (isInt(c.local) && (c.local as number) >= 0 && (c.local as number) < defs)) &&
    optBound(c.bound, imports) &&
    optIndex(c.alias, values) &&
    (c.aliasOf === undefined || isStr(c.aliasOf)) &&
    optIndex(c.result, calls) &&
    optIndex(c.table, tables);
  const isValue = (r: unknown) =>
    isObj(r) &&
    isStr(r.name) &&
    isInt(r.line) &&
    isInt(r.column) &&
    isInt(r.caller) &&
    (r.caller as number) < defs &&
    isReceiver(r.recv, imports) &&
    optIndex(r.local, defs) &&
    optBound(r.bound, imports) &&
    ROLES.has(r.role as string) &&
    optIndex(r.call, calls) &&
    (r.arg === undefined || (isInt(r.arg) && (r.arg as number) >= 0)) &&
    (r.key === undefined || isStr(r.key));
  const isTypeUse = (t: unknown) => isObj(t) && isTypeRef(t.ref, imports) && isInt(t.caller) && (t.caller as number) < defs;
  const isTable = (t: unknown) => isObj(t) && isStr(t.name) && isInt(t.line) && isList(t.values, (i) => isIndex(i, values), 4096) && optBool(t.open);
  const isImport = (i: unknown) =>
    isObj(i) &&
    isStr(i.spec) &&
    isInt(i.line) &&
    isInt(i.column) &&
    isList(i.names, (n) => isObj(n) && isStr(n.imported) && isStr(n.local), 4096) &&
    (i.namespace === null || isStr(i.namespace)) &&
    typeof i.star === "boolean" &&
    typeof i.reexport === "boolean" &&
    typeof i.typeOnly === "boolean" &&
    optBool(i.relative) &&
    optBool(i.alias) &&
    optBool(i.scoped) &&
    (i.staticMember === undefined || isStr(i.staticMember)) &&
    optBool(i.staticStar);
  return (
    isList(v.calls, isCall) &&
    isList(v.values, isValue) &&
    isList(v.types, isTypeUse) &&
    (v.typeCuts === undefined || (isInt(v.typeCuts) && (v.typeCuts as number) > 0)) &&
    isList(v.tables, isTable, 20_000) &&
    isList(v.imports, isImport, 20_000) &&
    isList(v.exportsLocal, (e) => isObj(e) && isStr(e.local) && isStr(e.exported) && (e.line === undefined || isInt(e.line)), 20_000) &&
    (v.defaultExport === null || isStr(v.defaultExport)) &&
    (v.goPackage === null || isStr(v.goPackage)) &&
    (v.javaPackage === undefined || v.javaPackage === null || isStr(v.javaPackage)) &&
    (v.frameworks === undefined || isFrameworkFileFacts(v.frameworks))
  );
}
