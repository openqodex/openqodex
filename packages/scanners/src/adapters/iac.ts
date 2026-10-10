// What trivy, checkov and tflint share: which files of a change they read,
// the Terraform folders each may be handed, a staging copy of exactly those
// files, and where in a file a finding is anchored.
//
// Terraform evaluates a module as its whole folder, so a changed `.tf` or
// `.tf.json` file brings its folder's Terraform files (not its subfolders) to
// the scanner. Kubernetes objects and CloudFormation templates are single
// files, known by their content (detect.ts). The scanners read a staging
// copy of those files outside the repository, never the repository itself:
// no settings file of the repository (`.checkov.yaml`, `trivy.yaml`,
// `.tflint.hcl`, a `.tflint.d` plugin folder) is in it, and a module call
// can reach no folder that was not staged.
//
// A module source is read from the folder's own files, as text, before any
// scanner starts: trivy downloads every module that is not a local path (it
// has no switch to stop it), so a folder that names one is never handed to
// trivy; checkov reads a local module path from disk wherever it points, so a
// folder whose module path leaves the repository is never handed to checkov.
//
// A finding is anchored to the narrowest lines the tool's output supports
// (`anchorFinding`, `blockCause`): the changed-line filter keeps a finding
// whose lines touch a changed line, and a finding spread over a whole
// resource would come back for every change to that resource.

import fs from "node:fs/promises";
import path from "node:path";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "yaml";
import { hclMasked } from "../comments.js";
import type { RepoFacts } from "../detect.js";
import { noLinkOnTheWay, readRepoFile, repoFileOrReason } from "./read.js";

export type IacKind = "terraform" | "kubernetes" | "cloudformation";

export const isTerraformPath = (p: string): boolean => p.endsWith(".tf") || p.endsWith(".tf.json");

// The Terraform files of a folder that a scanner loads with it: the
// configuration and the variable files Terraform reads on its own.
const isTerraformFolderFile = (name: string): boolean =>
  isTerraformPath(name) || /^terraform\.tfvars(\.json)?$/.test(name) || /\.auto\.tfvars(\.json)?$/.test(name);

export function iacKind(p: string, facts: RepoFacts): IacKind | null {
  if (isTerraformPath(p)) return "terraform";
  const content = facts.content(p);
  return content === "kubernetes" || content === "cloudformation" ? content : null;
}

// "" for a file at the repository root.
export const folderOf = (p: string): string => {
  const dir = path.posix.dirname(p);
  return dir === "." ? "" : dir;
};

// ---------- module sources ----------

// The largest Terraform file read for its module sources, and how many files
// of one folder are read. A folder past either is one whose modules are not
// known, and no scanner that needs them known gets it.
const MAX_TF_BYTES = 4 * 1024 * 1024;
const MAX_TF_FILES = 500;

// The source of every module a Terraform file calls, in file order, or null
// when the file cannot be read whole and for certain. This is the gate that
// decides whether trivy or Checkov may read a folder, and both read it with a
// full HCL parser, so anything this reader does not account for fails closed:
// a construct it does not model, a source that is not one plain string, a
// block left open, a `.tf.json` that does not parse, holds a key twice or has
// a `module` of another shape. What it accepts it reads as HCL does: string
// escapes, heredocs, blocks on one line, comments anywhere a blank may go.
// Only top-level `module` blocks (or the `module` key of a `.tf.json` file)
// call a module.
export function moduleSources(text: string, file: string): string[] | null {
  return file.endsWith(".json") ? jsonModuleSources(text) : hclModuleSources(text);
}

// The deepest nesting read; a deeper file is not read for certain.
const MAX_GATE_DEPTH = 256;

// The value of a quoted HCL string at `at` (its opening quote) with nothing
// to evaluate in it, and the offset past its closing quote; null for a
// template, a line end, an escape HCL does not have, or no closing quote.
function hclStringLiteral(text: string, at: number): { value: string; end: number } | null {
  let out = "";
  let i = at + 1;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') return { value: out, end: i + 1 };
    if (c === "\n" || c === "\r") return null;
    if (c === "\\") {
      const e = text[i + 1];
      if (e === "n") out += "\n";
      else if (e === "r") out += "\r";
      else if (e === "t") out += "\t";
      else if (e === '"') out += '"';
      else if (e === "\\") out += "\\";
      else if (e === "u" || e === "U") {
        const digits = e === "u" ? 4 : 8;
        const hex = text.slice(i + 2, i + 2 + digits);
        if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(hex)) return null;
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
        out += String.fromCodePoint(code);
        i += 2 + digits;
        continue;
      } else return null;
      i += 2;
      continue;
    }
    if ((c === "$" || c === "%") && text[i + 1] === "{") return null;
    if ((c === "$" || c === "%") && text[i + 1] === c && text[i + 2] === "{") {
      out += `${c}{`;
      i += 3;
      continue;
    }
    out += c;
    i++;
  }
  return null;
}

const HEREDOC_START = /^<<-?([A-Za-z_][A-Za-z0-9_-]*)\r?\n/;

// The offset past an HCL expression that starts at `i`: up to the line end
// outside brackets (not consumed), or, with `brace`, up to a `}` that closes
// the block it is in (not consumed). Strings, templates in them, heredocs
// and comments are skipped as HCL lexes them; a heredoc ends at the first
// line whose text is its word, a superset of the lines HCL ends one on. Null
// when the expression does not end cleanly. One pass, no recursion.
function skipExpression(text: string, start: number, brace: boolean): number | null {
  // "S": inside a quoted string; "T": inside a template sequence in one.
  const stack: string[] = [];
  let i = start;
  while (i < text.length) {
    const c = text[i] as string;
    const top = stack[stack.length - 1];
    if (top === "S") {
      if (c === '"') stack.pop();
      else if (c === "\n") return null;
      else if (c === "\\") i++;
      else if ((c === "$" || c === "%") && text[i + 1] === c && text[i + 2] === "{") i += 2;
      else if ((c === "$" || c === "%") && text[i + 1] === "{") {
        stack.push("T");
        i++;
      }
      i++;
      continue;
    }
    if (c === "\n") {
      if (stack.length === 0) return brace ? null : i;
      i++;
    } else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 2;
    } else if (c === '"') {
      stack.push("S");
      i++;
    } else if (c === "<" && text[i + 1] === "<") {
      const h = HEREDOC_START.exec(text.slice(i, i + 1100));
      if (!h) return null;
      const word = h[1] as string;
      let line = i + h[0].length;
      let closed = -1;
      while (line < text.length) {
        const eol = text.indexOf("\n", line);
        const end = eol < 0 ? text.length : eol;
        if (text.slice(line, end).trim() === word) {
          closed = end;
          break;
        }
        line = end + 1;
      }
      if (closed < 0) return null;
      i = closed;
    } else if (c === "(" || c === "[" || c === "{") {
      if (stack.length >= MAX_GATE_DEPTH * 16) return null;
      stack.push(c);
      i++;
    } else if (c === ")" || c === "]" || c === "}") {
      if (stack.length === 0) return brace && c === "}" ? i : null;
      const open = stack.pop();
      if (c === "}" && open === "T") {
        // Back inside the string the template sequence is in.
      } else if ((c === ")" && open !== "(") || (c === "]" && open !== "[") || (c === "}" && open !== "{")) return null;
      i++;
    } else {
      i++;
    }
  }
  return stack.length === 0 && !brace ? i : null;
}

function hclModuleSources(text: string): string[] | null {
  const n = text.length;
  let i = 0;
  const sources: string[] = [];
  // Blanks and comments on the line, never its end. False for a block
  // comment left open, or one that holds a line end (a statement must end
  // on its own line).
  const inline = (): boolean => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r") i++;
      else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end < 0 || text.slice(i, end).includes("\n")) return false;
        i = end + 2;
      } else return true;
    }
  };
  // The rest of a statement's line: blanks, then a line comment, then the
  // line end or the end of the file.
  const lineEnd = (): boolean => {
    if (!inline()) return false;
    if (text[i] === "#" || (text[i] === "/" && text[i + 1] === "/")) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? n : end;
    }
    if (i >= n) return true;
    if (text[i] !== "\n") return false;
    i++;
    return true;
  };
  // Blanks, line ends and comments between statements.
  const between = (): boolean => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") i++;
      else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
        const end = text.indexOf("\n", i);
        i = end < 0 ? n : end;
      } else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) return false;
        i = end + 2;
      } else return true;
    }
  };
  const ident = (): string | null => {
    if (!isIdentStart(text[i])) return null;
    const start = i;
    while (isIdentPart(text[i])) i++;
    return text.slice(start, i);
  };
  // One attribute's value after its `=`. For a module's source, the plain
  // string it must be; otherwise skipped. False when it does not end where a
  // statement must.
  const attribute = (name: string, isModule: boolean, found: string[], brace: boolean): boolean => {
    if (!inline()) return false;
    if (isModule && name === "source") {
      if (text[i] !== '"') return false;
      const literal = hclStringLiteral(text, i);
      if (literal === null) return false;
      i = literal.end;
      found.push(literal.value);
      return true;
    }
    const end = skipExpression(text, i, brace);
    if (end === null) return false;
    i = end;
    return true;
  };
  // A body: statements up to its closing brace (`closing`), or to the end of
  // the file. `isModule`: a top-level module block's body, whose source is
  // collected into `found`.
  const body = (closing: boolean, depth: number, isModule: boolean, found: string[]): boolean => {
    if (depth > MAX_GATE_DEPTH) return false;
    for (;;) {
      if (!between()) return false;
      if (i >= n) return !closing;
      if (text[i] === "}") {
        if (!closing) return false;
        i++;
        return true;
      }
      const name = ident();
      if (name === null) return false;
      if (!inline()) return false;
      if (text[i] === "=" && text[i + 1] !== "=") {
        i++;
        if (!attribute(name, isModule, found, false) || !lineEnd()) return false;
        continue;
      }
      // A block: labels (quoted or names) on its line, then its brace.
      for (;;) {
        if (!inline()) return false;
        if (text[i] === '"') {
          const label = hclStringLiteral(text, i);
          if (label === null) return false;
          i = label.end;
        } else if (isIdentStart(text[i])) {
          ident();
        } else break;
      }
      if (text[i] !== "{") return false;
      i++;
      const callsModule = depth === 0 && name === "module";
      const own: string[] = [];
      if (!inline()) return false;
      if (text[i] === "}") {
        i++;
      } else if (text[i] === "\n" || text[i] === "#" || (text[i] === "/" && text[i + 1] === "/") || i >= n) {
        if (!lineEnd() || !body(true, depth + 1, callsModule, own)) return false;
      } else {
        // A block on one line holds one attribute.
        const inner = ident();
        if (inner === null || !inline() || text[i] !== "=" || text[i + 1] === "=") return false;
        i++;
        if (!attribute(inner, callsModule, own, true) || !inline() || text[i] !== "}") return false;
        i++;
      }
      if (callsModule) {
        if (own.length !== 1) return false;
        sources.push(own[0] as string);
      }
      if (!lineEnd()) return false;
    }
  };
  return body(false, 0, false, []) ? sources : null;
}

// A JSON literal or number, matched where the reader is (sticky), so a file
// of many values is read in one pass.
const JSON_SCALAR = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

// A JSON value, or undefined for text that is not JSON, holds an object key
// twice (JSON.parse keeps the last, HCL's JSON reader both), or nests deeper
// than the gate reads.
function strictJson(text: string): unknown {
  let i = 0;
  const blanks = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const fail = Symbol("fail");
  // A JSON string: no raw control character, only JSON's escapes.
  const string = (): string | typeof fail => {
    if (text[i] !== '"') return fail;
    let j = i + 1;
    for (;;) {
      if (j >= text.length) return fail;
      const c = text.charCodeAt(j);
      if (c === 0x22) break;
      if (c < 0x20) return fail;
      if (c === 0x5c) {
        const e = text[j + 1];
        if (e === "u") {
          if (!/^[0-9A-Fa-f]{4}$/.test(text.slice(j + 2, j + 6))) return fail;
          j += 6;
          continue;
        }
        if (e === undefined || !'"\\/bfnrt'.includes(e)) return fail;
        j += 2;
        continue;
      }
      j++;
    }
    const raw = text.slice(i, j + 1);
    i = j + 1;
    return JSON.parse(raw) as string;
  };
  const value = (depth: number): unknown => {
    if (depth > MAX_GATE_DEPTH) return fail;
    blanks();
    const c = text[i];
    if (c === "{") {
      i++;
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      blanks();
      if (text[i] === "}") {
        i++;
        return out;
      }
      for (;;) {
        blanks();
        const key = string();
        if (key === fail || seen.has(key)) return fail;
        seen.add(key);
        blanks();
        if (text[i] !== ":") return fail;
        i++;
        const v = value(depth + 1);
        if (v === fail) return fail;
        out[key] = v;
        blanks();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] !== "}") return fail;
        i++;
        return out;
      }
    }
    if (c === "[") {
      i++;
      const out: unknown[] = [];
      blanks();
      if (text[i] === "]") {
        i++;
        return out;
      }
      for (;;) {
        const v = value(depth + 1);
        if (v === fail) return fail;
        out.push(v);
        blanks();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] !== "]") return fail;
        i++;
        return out;
      }
    }
    if (c === '"') return string();
    JSON_SCALAR.lastIndex = i;
    const m = JSON_SCALAR.exec(text);
    if (!m) return fail;
    i += m[0].length;
    return JSON.parse(m[0]) as unknown;
  };
  const v = value(0);
  blanks();
  return v === fail || i !== text.length ? undefined : v;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// The `module` key of a `.tf.json` file: an object (or a list of them) of
// module names, each to an object (or a list of them) with a `source`
// string. A `//` key at the name level is a comment, as Terraform reads it.
// A source holding a template sequence is not read for certain.
function jsonModuleSources(text: string): string[] | null {
  const parsed = strictJson(text);
  if (!isObject(parsed)) return null;
  if (!("module" in parsed)) return [];
  const out: string[] = [];
  const modules = parsed.module;
  for (const named of Array.isArray(modules) ? modules : [modules]) {
    if (!isObject(named)) return null;
    for (const [name, bodies] of Object.entries(named)) {
      if (name === "//") continue;
      for (const body of Array.isArray(bodies) ? bodies : [bodies]) {
        if (!isObject(body)) return null;
        const source = body.source;
        if (typeof source !== "string" || source.includes("${") || source.includes("%{")) return null;
        out.push(source);
      }
    }
  }
  return out;
}

export type ModuleVerdict = { trivy: boolean; checkov: boolean };

// Whether trivy and checkov may read a folder whose modules have these
// sources. trivy: only `./` and `../` paths that stay inside the repository,
// which it resolves against the staging copy: enough `../` would reach any
// folder on the machine. checkov: any source except one that is not known
// (an expression), an absolute path, or a `./` or `../` path that leaves the
// repository; it downloads nothing (no --download-external-modules). The
// staging copy holds the same folders at the same paths, and only folders
// whose own sources passed here, so a module a staged module calls in turn
// is either one of them or not there at all.
export function moduleVerdict(folder: string, sources: readonly string[]): ModuleVerdict {
  const local = (s: string): boolean => s.startsWith("./") || s.startsWith("../");
  const inside = (s: string): boolean => {
    const resolved = path.posix.normalize(path.posix.join(folder === "" ? "." : folder, s));
    return resolved !== ".." && !resolved.startsWith("../");
  };
  const trivy = sources.every((s) => local(s) && inside(s));
  const checkov = sources.every((s) => !s.startsWith("/") && !s.startsWith("~") && (!local(s) || inside(s)));
  return { trivy, checkov };
}

// The verdict for one folder of the repository, from its Terraform files read
// as text. A folder that cannot be listed, or holds a file that cannot be
// read whole and for certain (moduleSources), gets neither.
export async function folderVerdict(repoDir: string, folder: string): Promise<ModuleVerdict> {
  const none = { trivy: false, checkov: false };
  const names = await terraformFilesIn(repoDir, folder);
  if (names === null) return none;
  const sources: string[] = [];
  for (const name of names) {
    if (!isTerraformPath(name)) continue;
    const rel = folder === "" ? name : `${folder}/${name}`;
    let text: string;
    try {
      text = await readRepoFile(repoDir, rel, MAX_TF_BYTES);
    } catch {
      return none;
    }
    const found = moduleSources(text, name);
    if (found === null) return none;
    sources.push(...found);
  }
  return moduleVerdict(folder, sources);
}

// The names of a folder's own Terraform files, or null when the folder is a
// link, is reached through one, cannot be listed, or holds too many.
async function terraformFilesIn(repoDir: string, folder: string): Promise<string[] | null> {
  if (folder !== "" && !noLinkOnTheWay(repoDir, `${folder}/x`)) return null;
  const abs = path.join(repoDir, folder);
  try {
    if (folder !== "" && (await fs.lstat(abs)).isSymbolicLink()) return null;
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const names = entries.filter((e) => e.isFile() && isTerraformFolderFile(e.name)).map((e) => e.name).sort();
    return names.length > MAX_TF_FILES ? null : names;
  } catch {
    return null;
  }
}

// ---------- staging ----------

// The largest file staged; a larger one is left out.
const MAX_STAGED_BYTES = 16 * 1024 * 1024;

export type Stage = {
  // The folder that holds the copy of the repository's files, and the
  // scanner's home, temporary and cache folders beside it.
  root: string;
  tree: string;
  home: string;
  tmp: string;
  // The repo-relative files staged.
  files: string[];
};

// A fresh staging copy, outside the repository, of each folder's own
// Terraform files and of each named file: hard links where the file system
// allows, copies where it does not. Only a regular file inside the
// repository, reached through no link, is staged; never a file named
// `.checkov.yaml` or `.checkov.yml`, which checkov reads as its settings.
// The stage is made in `tempRoot`, the run's temporary folder (scratch.ts).
// `use` gets the stage; it is removed afterwards.
export async function withStage<T>(tempRoot: string, repoDir: string, folders: string[], files: string[], use: (stage: Stage) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(tempRoot, "openqodex-iac-"));
  try {
    const stage: Stage = { root, tree: path.join(root, "tree"), home: path.join(root, "home"), tmp: path.join(root, "tmp"), files: [] };
    await Promise.all([fs.mkdir(stage.tree), fs.mkdir(stage.home), fs.mkdir(stage.tmp)]);
    const wanted = new Set<string>();
    for (const folder of folders) {
      for (const name of (await terraformFilesIn(repoDir, folder)) ?? []) wanted.add(folder === "" ? name : `${folder}/${name}`);
    }
    for (const file of files) wanted.add(file);
    for (const rel of [...wanted].sort()) {
      const base = path.posix.basename(rel);
      if (base === ".checkov.yaml" || base === ".checkov.yml") continue;
      const checked = await repoFileOrReason(repoDir, rel, MAX_STAGED_BYTES).catch(() => ({ reason: "gone" }));
      if ("reason" in checked || !noLinkOnTheWay(repoDir, rel)) continue;
      const dest = path.join(stage.tree, path.normalize(rel));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try {
        await fs.link(checked.path, dest);
      } catch {
        await fs.copyFile(checked.path, dest);
      }
      stage.files.push(rel);
    }
    return await use(stage);
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

// A path a scanner printed for a staged file, back to the repository's:
// "/infra/main.tf", "./infra/main.tf" and "infra/main.tf" are "infra/main.tf".
export function stagedPath(p: string): string {
  let rel = p.replace(/\\/g, "/");
  while (rel.startsWith("/") || rel.startsWith("./")) rel = rel.startsWith("/") ? rel.slice(1) : rel.slice(2);
  return rel;
}

// ---------- the structure of a file ----------

// A line number (1-based) for each offset, by binary search over the line
// starts.
function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// The deepest structure read; anything deeper is one opaque value.
const MAX_DEPTH = 200;

type HclNode = {
  kind: "block" | "attr";
  name: string;
  line: number;
  endLine: number;
  children: HclNode[];
  // An attribute's value, as offsets in the file.
  valueFrom: number;
  valueTo: number;
};

const isIdentStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_]/.test(c);
const isIdentPart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_-]/.test(c);
const HEREDOC = /^<<-?([A-Za-z_][A-Za-z0-9_-]*)\r?\n/;

// The blocks and attributes of an HCL file, nested, read from its code alone
// (comments.ts, hclMasked): a string, a heredoc body or a comment holds no
// brace, `=` or line end that counts. An attribute's value runs to the line
// end outside brackets, or to the brace that closes its block; a heredoc
// value runs to its closing word. Anything else on a line is skipped.
function hclStructure(text: string): HclNode[] {
  const m = hclMasked(text);
  const lineOf = lineIndex(m);
  // The heredoc closing lines: each line's trimmed text to its starts.
  let closers: Map<string, number[]> | null = null;
  const closerAfter = (word: string, from: number): number => {
    if (closers === null) {
      closers = new Map();
      let start = 0;
      while (start <= m.length) {
        const end = m.indexOf("\n", start);
        const key = m.slice(start, end < 0 ? m.length : end).trim();
        if (key.length <= 1024) {
          const at = closers.get(key);
          if (at) at.push(start);
          else closers.set(key, [start]);
        }
        if (end < 0) break;
        start = end + 1;
      }
    }
    const at = closers.get(word) ?? [];
    let lo = 0;
    let hi = at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((at[mid] as number) < from) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= at.length) return -1;
    const end = m.indexOf("\n", at[lo] as number);
    return end < 0 ? m.length : end;
  };

  let i = 0;
  const blanks = (): void => {
    while (m[i] === " " || m[i] === "\t" || m[i] === "\r") i++;
  };
  const skipLine = (): void => {
    const end = m.indexOf("\n", i);
    i = end < 0 ? m.length : end + 1;
  };
  const ident = (): string | null => {
    if (!isIdentStart(m[i])) return null;
    const start = i;
    while (isIdentPart(m[i])) i++;
    return m.slice(start, i);
  };
  // The offset of the last character that is not a blank in [from, to).
  const lastCode = (from: number, to: number): number => {
    let k = to - 1;
    while (k > from && /\s/.test(m[k] as string)) k--;
    return k;
  };
  // Moves `i` to the end of an attribute's value.
  const value = (): void => {
    let depth = 0;
    while (i < m.length) {
      const c = m[i] as string;
      if (c === "\n") {
        if (depth === 0) return;
      } else if (c === "(" || c === "[" || c === "{") {
        depth++;
      } else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) return;
        depth--;
      } else if (c === "<" && m[i + 1] === "<") {
        const h = HEREDOC.exec(m.slice(i, i + 1100));
        const end = h ? closerAfter(h[1] as string, i + h[0].length) : -1;
        if (end >= 0) {
          i = end;
          continue;
        }
      }
      i++;
    }
  };
  // Skips a block's body, braces counted, up to past its closing brace.
  const skipBody = (): void => {
    let depth = 0;
    while (i < m.length) {
      const c = m[i++];
      if (c === "{") depth++;
      else if (c === "}" && depth-- === 0) return;
    }
  };
  const body = (closing: boolean, depth: number): HclNode[] => {
    const nodes: HclNode[] = [];
    while (i < m.length) {
      while (i < m.length && /\s/.test(m[i] as string)) i++;
      if (i >= m.length) break;
      if (m[i] === "}") {
        i++;
        if (closing) return nodes;
        continue;
      }
      const start = i;
      const name = ident();
      if (name === null) {
        skipLine();
        continue;
      }
      blanks();
      if (m[i] === "=" && m[i + 1] !== "=") {
        i++;
        const valueFrom = i;
        value();
        nodes.push({ kind: "attr", name, line: lineOf(start), endLine: lineOf(lastCode(valueFrom, i)), children: [], valueFrom, valueTo: i });
        continue;
      }
      // A block: labels (quoted, or names), then its opening brace.
      let open = true;
      while (i < m.length && m[i] !== "{") {
        if (m[i] === '"') {
          const close = m.indexOf('"', i + 1);
          const eol = m.indexOf("\n", i + 1);
          if (close < 0 || (eol >= 0 && eol < close)) {
            open = false;
            break;
          }
          i = close + 1;
        } else if (isIdentStart(m[i])) {
          ident();
        } else {
          open = false;
          break;
        }
        blanks();
      }
      if (!open || m[i] !== "{") {
        skipLine();
        continue;
      }
      i++;
      let children: HclNode[] = [];
      if (depth < MAX_DEPTH) children = body(true, depth + 1);
      else skipBody();
      nodes.push({ kind: "block", name, line: lineOf(start), endLine: lineOf(Math.max(start, i - 1)), children, valueFrom: start, valueTo: i });
    }
    return nodes;
  };
  return body(false, 0);
}

type YamlNode = {
  kind: "map" | "seq" | "scalar";
  line: number;
  endLine: number;
  entries: { key: string; line: number; endLine: number; value: YamlNode }[];
  items: { line: number; endLine: number; value: YamlNode }[];
};

type Ranged = { range?: [number, number, number] } | null | undefined;

// The largest YAML file whose structure is read; a larger one, or one the
// parser cannot read, has none, and its findings keep the resource's first
// line.
const MAX_YAML_BYTES = 4 * 1024 * 1024;

// The documents of a YAML or JSON file, each as its root node with the lines
// of every key and item, read by the `yaml` library (it builds a syntax tree
// and runs nothing). An alias is a value of its own line; a document with an
// error has no structure.
function yamlDocuments(text: string): YamlNode[] {
  if (text.length > MAX_YAML_BYTES) return [];
  const lineOf = lineIndex(text);
  // The line of the last character of a node that is not a blank.
  const lastLine = (from: number, to: number): number => {
    let k = to - 1;
    while (k > from && /\s/.test(text[k] as string)) k--;
    return lineOf(Math.max(from, k));
  };
  const scalar = (line: number): YamlNode => ({ kind: "scalar", line, endLine: line, entries: [], items: [] });
  const convert = (node: unknown, depth: number): YamlNode | null => {
    const range = (node as Ranged)?.range;
    if (!range) return null;
    const out: YamlNode = { ...scalar(lineOf(range[0])), endLine: lastLine(range[0], range[1]) };
    if (depth >= MAX_DEPTH) return out;
    if (isMap(node)) {
      out.kind = "map";
      for (const pair of node.items) {
        const keyRange = (pair.key as Ranged)?.range;
        if (!isScalar(pair.key) || !keyRange) continue;
        const line = lineOf(keyRange[0]);
        const value = convert(pair.value, depth + 1) ?? scalar(line);
        out.entries.push({ key: String(pair.key.value), line, endLine: Math.max(line, value.endLine), value });
      }
    } else if (isSeq(node)) {
      out.kind = "seq";
      for (const item of node.items) {
        const value = convert(item, depth + 1);
        if (value) out.items.push({ line: value.line, endLine: value.endLine, value });
      }
    } else if (!isScalar(node) && !isAlias(node)) {
      return null;
    }
    return out;
  };
  try {
    const docs = parseAllDocuments(text, { prettyErrors: false, uniqueKeys: false, strict: false });
    if (!Array.isArray(docs)) return [];
    const out: YamlNode[] = [];
    for (const doc of docs) {
      if (doc.errors.length > 0) continue;
      const root = convert(doc.contents, 0);
      if (root) out.push(root);
    }
    return out;
  } catch {
    // Nesting too deep for the parser.
    return [];
  }
}

// ---------- anchoring ----------

type Format = "hcl" | "yaml" | "json";

function formatOf(file: string, text: string): Format {
  if (file.endsWith(".tf")) return "hcl";
  if (file.endsWith(".json")) return "json";
  if (file.endsWith(".template")) return text.trimStart().startsWith("{") ? "json" : "yaml";
  return "yaml";
}

// One step of a key path, resolved: the lines of the node it reached.
type Step = { line: number; endLine: number };

// A key path ("ingress/[0]/cidr_blocks") walked into an HCL block: the
// attribute or block it names, an attribute when the path goes on into its
// value, or the steps it got through before a name that is not there.
function walkHcl(root: HclNode, segments: string[]): { done: boolean; steps: Step[] } {
  const steps: Step[] = [];
  let at = root;
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k] as string;
    const index = /^\[(\d+)\]$/.exec(segments[k + 1] ?? "");
    const named = at.children.filter((c) => c.name === seg);
    const next = named[index ? Number(index[1]) : 0];
    if (!next) return { done: false, steps };
    if (index) k++;
    steps.push({ line: next.line, endLine: next.endLine });
    if (next.kind === "attr") return { done: true, steps };
    at = next;
  }
  return { done: true, steps };
}

function walkYaml(root: YamlNode, segments: string[]): { done: boolean; steps: Step[] } {
  const steps: Step[] = [];
  let at = root;
  for (const seg of segments) {
    if (at.kind === "scalar") return { done: steps.length > 0, steps };
    const index = /^\[(\d+)\]$/.exec(seg);
    if (index) {
      const item = at.items[Number(index[1])];
      if (at.kind !== "seq" || !item) return { done: false, steps };
      steps.push({ line: item.line, endLine: item.endLine });
      at = item.value;
      continue;
    }
    const entry = at.kind === "map" ? at.entries.find((e) => e.key === seg) : undefined;
    if (!entry) return { done: false, steps };
    steps.push({ line: entry.line, endLine: entry.endLine });
    at = entry.value;
  }
  return { done: true, steps };
}

// The YAML node a resource that starts on `line` is read from: a document
// whose root starts there, or the value of a key on that line.
function yamlRoot(docs: YamlNode[], line: number): YamlNode | null {
  for (const doc of docs) if (doc.line === line) return doc;
  const stack = [...docs];
  while (stack.length > 0) {
    const n = stack.pop() as YamlNode;
    for (const e of n.entries) {
      if (e.line === line && e.value.kind === "map") return e.value;
      stack.push(e.value);
    }
    for (const it of n.items) stack.push(it.value);
  }
  return null;
}

export type FileIndex = {
  // The lines a finding on the resource [start, end] is anchored to, from the
  // key paths the scanner says it evaluated: one span over them all.
  anchor(start: number, end: number, keys: string[]): [number, number];
  // The same, one range per key path found, in file order, so a line between
  // two of them (an attribute the scanner did not evaluate) is in none.
  anchorRanges(start: number, end: number, keys: string[]): [number, number][];
  // The lines a cause [start, end] is anchored to: its first line when it is
  // a whole block.
  blockCause(start: number, end: number): [number, number];
};

export function indexFile(text: string, file: string): FileIndex {
  const format = formatOf(file, text);
  let hcl: HclNode[] | null = null;
  let yaml: YamlNode[] | null = null;
  const hclNodes = () => (hcl ??= hclStructure(text));
  const yamlNodes = () => (yaml ??= yamlDocuments(text));
  const ranges = (start: number, end: number, keys: string[]): [number, number][] => {
      const walks: { done: boolean; steps: Step[] }[] = [];
      if (format === "hcl") {
        const root = hclNodes().find((n) => n.kind === "block" && n.line === start);
        if (root) for (const key of keys) walks.push(walkHcl(root, key.split("/")));
      } else if (format === "yaml") {
        const root = yamlRoot(yamlNodes(), start);
        if (root) for (const key of keys) walks.push(walkYaml(root, key.split("/")));
      }
      const done = walks.filter((w) => w.done && w.steps.length > 0).map((w) => w.steps[w.steps.length - 1] as Step);
      if (done.length > 0) return done.map((s): [number, number] => [s.line, s.endLine]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      // Nothing named exists: the first line of the deepest node on a path
      // that does, else the resource's own first line.
      let best: Step | null = null;
      let depth = 0;
      for (const w of walks) {
        const last = w.steps[w.steps.length - 1];
        if (last && (w.steps.length > depth || (w.steps.length === depth && best !== null && last.line < best.line))) {
          best = last;
          depth = w.steps.length;
        }
      }
      return best ? [[best.line, best.line]] : [[start, start]];
  };
  return {
    anchorRanges: ranges,
    anchor(start, end, keys) {
      const found = ranges(start, end, keys);
      return [Math.min(...found.map((r) => r[0])), Math.max(...found.map((r) => r[1]))];
    },
    blockCause(start, end) {
      if (end <= start) return [start, start];
      if (format === "hcl") {
        const stack = [...hclNodes()];
        while (stack.length > 0) {
          const n = stack.pop() as HclNode;
          if (n.kind === "block" && n.line === start && n.endLine === end) return [start, start];
          stack.push(...n.children);
        }
      } else if (format === "yaml") {
        const blockish = (v: YamlNode) => v.kind === "map" || (v.kind === "seq" && v.items.some((it) => it.value.kind === "map"));
        const stack = [...yamlNodes()];
        for (const doc of stack) if (doc.line === start && doc.endLine === end && blockish(doc)) return [start, start];
        while (stack.length > 0) {
          const n = stack.pop() as YamlNode;
          for (const e of n.entries) {
            if (e.line === start && e.endLine === end && blockish(e.value)) return [start, start];
            stack.push(e.value);
          }
          for (const it of n.items) {
            if (it.line === start && it.endLine === end && blockish(it.value)) return [start, start];
            stack.push(it.value);
          }
        }
      }
      return [start, end];
    },
  };
}

export const anchorFinding = (text: string, file: string, start: number, end: number, keys: string[]): [number, number] =>
  indexFile(text, file).anchor(start, end, keys);

export const blockCause = (text: string, file: string, start: number, end: number): [number, number] => indexFile(text, file).blockCause(start, end);

// The text of each file a scanner reported on, read once from the
// repository; null for a file that cannot be read.
export function fileTexts(repoDir: string): (rel: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (rel) => {
    let text = cache.get(rel);
    if (!text) {
      text = readRepoFile(repoDir, rel, MAX_STAGED_BYTES).catch(() => null);
      cache.set(rel, text);
    }
    return text;
  };
}
